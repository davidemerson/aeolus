import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';

import { findReverseTarget, type SynctexMap } from '../lib/synctex.js';

interface PdfPreviewProps {
  url: string | null;
  // Parsed synctex map. When present, page clicks are converted to
  // source-line jumps via onSourceJump, and the host can drive a
  // forward jump by setting `scrollToPage`.
  syncMap?: SynctexMap | null;
  // When this changes (typically because the user pressed the
  // "Show in PDF" command in the editor), scroll the matching page
  // into view and flash its border.
  scrollToPage?: number | null;
  // Reverse-jump callback. Fires when the user clicks anywhere on a
  // rendered page; the host (doc-editor.tsx) wires this to the
  // editor's jump-to-line handler.
  onSourceJump?: (file: string, line: number) => void;
}

// One-shot worker bootstrap. Was at module-eval; lifting it inside
// the component lets a React.lazy() consumer defer the entire
// pdfjs-dist core bundle until a doc is actually opened.
let pdfWorkerConfigured = false;
function ensurePdfWorker(): void {
  if (pdfWorkerConfigured) return;
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  pdfWorkerConfigured = true;
}

// Render every page of the PDF stacked vertically. We need this for
// synctex jumps to work — a forward jump to "page 7" is only useful
// when page 7 is actually rendered. PDFs at the project's compile
// scale (single-doc, paper-sized) generally have a handful of
// pages, so eager-rendering is fine.
//
// Layout (canvas wrappers, in page order) is built first in a fast
// sequential loop; the actual page.render calls are then drained by a
// small worker pool so page 2's pixel rasterisation can overlap with
// page 1's. CONCURRENCY=3 keeps the pdf.js worker thread busy without
// flooding it; workers pull the lowest unfinished index, so users
// still see the document fill in mostly top-down.
const RENDER_CONCURRENCY = 3;
async function renderAllPages(
  doc: PDFDocumentProxy,
  container: HTMLDivElement,
  scaleHint: number,
  onCanvasMounted: (page: number, canvas: HTMLCanvasElement, scale: number) => void,
  cancelled: { value: boolean },
): Promise<void> {
  interface PageRenderWork {
    page: import('pdfjs-dist').PDFPageProxy;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    viewport: ReturnType<import('pdfjs-dist').PDFPageProxy['getViewport']>;
  }
  const works: PageRenderWork[] = [];

  for (let i = 1; i <= doc.numPages; i += 1) {
    if (cancelled.value) return;
    const page = await doc.getPage(i);
    const unscaled = page.getViewport({ scale: 1 });
    const containerWidth = container.clientWidth - 32;
    const scale = Math.min(containerWidth / unscaled.width, scaleHint);
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    // bg-white is LITERAL on purpose, and the one place in this app where it is
    // correct. The rendered page stays WHITE in both themes: it is a document,
    // not a UI surface — the user prints it, and PDF.js paints the page's own
    // white ground onto the canvas regardless. A themed var() here is exactly
    // the bug (a bulk bg-white -> bg-surface pass had introduced it).
    //
    // border-paper-edge, not border-hairline-strong: in light that hairline is
    // load-bearing (#fff on the gutter below is barely a shade apart), and on
    // dark it resolves to transparent, because a white page on a near-black
    // gutter is the brightest thing on screen and a mid-grey frame around it
    // reads as a stray rule. The gutter is what goes dark; see the host below.
    wrapper.className =
      // text-ink-900 is the light-island treatment (the .paper
      // recipe): a fixed literal, not a role, because this surface never flips.
      // The wrapper only ever holds a canvas today, so nothing in it reads —
      // but inheriting the app's text colour onto a permanently-white ground is
      // a trap that costs one class to close, and the next person to add a page
      // label here would ship near-white on white.
      'pdf-page mb-4 border border-paper-edge bg-white text-ink-900 shadow-card transition-colors';
    wrapper.dataset.pdfPage = String(i);

    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.dataset.pdfPage = String(i);
    // Carry the legacy `pdf-canvas` testid only on page 1 so the
    // E2E suite (compile-and-preview.spec.ts) keeps its single-
    // element locator. The pre-synctex PdfPreview rendered just
    // page 1, so this matches the historical assertion shape.
    if (i === 1) {
      canvas.setAttribute('data-testid', 'pdf-canvas');
    }
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    onCanvasMounted(i, canvas, scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    works.push({ page, canvas, ctx, viewport });
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(RENDER_CONCURRENCY, works.length) }, async () => {
      while (!cancelled.value) {
        const my = next;
        next += 1;
        if (my >= works.length) return;
        const w = works[my];
        await w.page.render({
          canvasContext: w.ctx,
          canvas: w.canvas,
          viewport: w.viewport,
        }).promise;
      }
    }),
  );
}

export function PdfPreview({ url, syncMap, scrollToPage, onSourceJump }: PdfPreviewProps) {
  ensurePdfWorker();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Per-page render scale (canvas px ÷ PDF pt). Click handlers use
  // this to convert click coords back into PDF coordinates.
  const pageScalesRef = useRef<Map<number, number>>(new Map());
  const [pageInfo, setPageInfo] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // True from the moment a URL arrives until every page has been drawn.
  // Rasterising a long document takes a visible while, during which the
  // gutter used to sit blank as if the compile had produced nothing.
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!url) return;

    const cancelled = { value: false };
    setRendering(true);
    // pdfjs-dist 6: the document is torn down through the loading task
    // (PDFDocumentProxy.destroy() is gone), and getDocument takes a
    // parameters object rather than a bare URL string.
    const task = getDocument({ url });

    void (async () => {
      try {
        setError(null);
        const doc: PDFDocumentProxy = await task.promise;
        if (cancelled.value) {
          await task.destroy();
          return;
        }
        setPageInfo(`${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`);

        const container = containerRef.current;
        if (!container) return;
        // Clear any previous render (re-compile, url change).
        container.querySelectorAll('.pdf-page').forEach((n) => n.remove());
        pageScalesRef.current.clear();

        await renderAllPages(
          doc,
          container,
          2,
          (page, _canvas, scale) => {
            pageScalesRef.current.set(page, scale);
          },
          cancelled,
        );
      } catch (err) {
        if (!cancelled.value) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF');
        }
      } finally {
        if (!cancelled.value) setRendering(false);
      }
    })();

    return () => {
      cancelled.value = true;
      void task.destroy();
    };
  }, [url]);

  // Scroll-to-page: when the host updates `scrollToPage` (forward
  // jump from the editor), find that page's wrapper and bring it
  // into view, then flash a brand-coloured border for ~1 s.
  useEffect(() => {
    if (scrollToPage == null) return;
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLDivElement>(
      `.pdf-page[data-pdf-page="${scrollToPage}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('ring-2', 'ring-focus');
    const handle = window.setTimeout(() => {
      target.classList.remove('ring-2', 'ring-focus');
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [scrollToPage]);

  // Reverse-jump click handler. Delegated at the container so we
  // don't have to track per-page listeners as they re-render.
  // `url` is in the dep list because PdfPreview's "no PDF yet"
  // branch renders a *different* element with no ref attachment;
  // when url goes from null → set, the container ref's current
  // changes from null → real, and we need this effect to re-run so
  // the listener actually lands on the rendered element.
  useEffect(() => {
    if (!syncMap || !onSourceJump || !url) return;
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const canvas = target.closest('canvas[data-pdf-page]') as HTMLCanvasElement | null;
      if (!canvas) return;
      const page = Number(canvas.dataset.pdfPage);
      if (!Number.isFinite(page)) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const scale = pageScalesRef.current.get(page) ?? 1;
      // Canvas CSS px / scale = PDF pt (origin top-left).
      const pdfX = px / scale;
      const pdfY = py / scale;
      const box = findReverseTarget(syncMap, page, pdfX, pdfY);
      if (box) onSourceJump(box.file, box.line);
    };

    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  }, [syncMap, onSourceJump, url]);

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        No PDF yet — click Compile.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-accent-text">
        {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // bg-page, not a tinted fill: this is the gutter around the white
      // page, and it is the surface that carries the theme here.
      className="flex h-full flex-col items-center overflow-auto bg-page p-4"
      data-testid="pdf-preview"
    >
      {(pageInfo || rendering) && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          {rendering ? (
            <span role="status" data-testid="pdf-rendering">
              Rendering…
            </span>
          ) : null}
          {pageInfo ? <span>{pageInfo}</span> : null}
          <span
            hidden={!pageInfo}
            data-testid="pdf-synctex-indicator"
            data-synctex={syncMap ? 'on' : 'off'}
            title={
              syncMap
                ? 'SyncTeX is active — click anywhere on the PDF to jump to the matching source line.'
                : 'SyncTeX is not available for this PDF. Click Compile to enable click-to-source jumps.'
            }
            className={`rounded-badge px-1.5 py-0.5 font-mono text-[10px] ${
              syncMap ? 'bg-success-bg text-success-fg' : 'bg-neutral-bg text-neutral-fg'
            }`}
          >
            synctex {syncMap ? 'on' : 'off'}
          </span>
        </div>
      )}
    </div>
  );
}
