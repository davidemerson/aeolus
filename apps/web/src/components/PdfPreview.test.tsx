import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// pdf.js is mocked wholesale: one page whose render() promise the test holds
// open, so the component can be observed in its "pages still drawing" state.
const renderGate = { resolve: () => {} };
vi.mock('pdfjs-dist', () => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({
      promise: new Promise<void>((resolve) => {
        renderGate.resolve = resolve;
      }),
    }),
  };
  const doc = { numPages: 1, getPage: async () => page };
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }),
  };
});

import { PdfPreview } from './PdfPreview.js';

beforeEach(() => {
  // happy-dom has no 2D context; the component skips a page it cannot draw,
  // so give it one that accepts the transform call.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ setTransform: () => {} }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PdfPreview rendering indicator', () => {
  it('shows Rendering… while pages rasterise and clears it when they are drawn', async () => {
    render(<PdfPreview url="/api/docs/d1/pdf" />);
    const status = await waitFor(() => screen.getByTestId('pdf-rendering'));
    expect(status.textContent).toBe('Rendering…');
    expect(status.getAttribute('role')).toBe('status');
    // The page count is known before the pixels are.
    await waitFor(() => screen.getByText('1 page'));
    expect(screen.getByTestId('pdf-rendering')).toBeTruthy();

    renderGate.resolve();
    await waitFor(() => {
      expect(screen.queryByTestId('pdf-rendering')).toBeNull();
    });
    expect(screen.getByText('1 page')).toBeTruthy();
  });

  it('shows nothing of the sort before there is a PDF', () => {
    render(<PdfPreview url={null} />);
    expect(screen.queryByTestId('pdf-rendering')).toBeNull();
    expect(screen.getByText('No PDF yet — click Compile.')).toBeTruthy();
  });
});
