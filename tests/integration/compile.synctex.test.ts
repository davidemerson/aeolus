import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';

// Multi-line latex so synctex emits records spread across more than
// a single source line. Padding with comments increases the chance
// of distinct (F,L:...) entries on different source lines.
const LATEX_SOURCE = String.raw`\documentclass{article}
\begin{document}
% line 3
First paragraph on line 4.

Second paragraph on line 6.

\end{document}
`;

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev sessions: ${res.status}`);
  const sc = res.headers.get('set-cookie');
  const p = parseSetCookie(sc!);
  return `${p!.name}=${p!.value}`;
}

interface CompileStatusJson {
  status: 'queued' | 'running' | 'success' | 'failed';
  pdf_url: string | null;
  synctex_url: string | null;
  error: string | null;
  job_id: string;
}

describe('compile pipeline — synctex', () => {
  let fx: CompileFixtures;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('emits a parsed synctex map alongside the PDF and serves it via /synctex', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `synctex-${Date.now()}@example.com`, name: 'SyncTeX User' })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'synctex-test', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, LATEX_SOURCE);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const enqueue = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(enqueue.status).toBe(202);
    const { job_id: jobId } = (await enqueue.json()) as { job_id: string };

    const deadline = Date.now() + 90_000;
    let status: CompileStatusJson | null = null;
    while (Date.now() < deadline) {
      const r = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile/${jobId}`, {
        headers: { cookie },
      });
      status = (await r.json()) as CompileStatusJson;
      if (status.status === 'success' || status.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 500));
    }

    if (!status || status.status !== 'success') {
      throw new Error(`compile did not succeed: ${JSON.stringify(status)}`);
    }
    // Status response advertises a synctex URL.
    expect(status.synctex_url).toBe(`/docs/${doc.id}/compile/${jobId}/synctex`);

    // Fetching it returns a JSON map keyed by source filename with
    // boxes for at least one line of the source.
    const sx = await fetch(`${fx.apiBaseUrl}/api${status.synctex_url}`, { headers: { cookie } });
    expect(sx.status).toBe(200);
    expect(sx.headers.get('content-type')).toContain('application/json');
    const map = (await sx.json()) as {
      version: number;
      files: string[];
      forward: Record<string, Array<{ line: number; page: number }>>;
      reverse: Record<string, Array<{ line: number; page: number }>>;
    };
    expect(map.version).toBe(1);
    expect(map.files).toContain('main.tex');
    const main = map.forward['main.tex'];
    expect(main.length).toBeGreaterThan(0);
    // Records should land within the body range — synctex doesn't
    // necessarily emit one per source line (TeX emits records for
    // typeset boxes, which align to paragraph starts and the like),
    // so we assert at least one record falls inside the body.
    expect(main.some((b) => b.line >= 3 && b.line <= 8)).toBe(true);
    // Page 1 entries exist in the reverse map.
    expect(Object.keys(map.reverse).length).toBeGreaterThan(0);
    expect(map.reverse['1'].length).toBeGreaterThan(0);
  }, 180_000);

  it('returns 404 on /synctex when the engine is typst (no sync map)', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `synctex-typst-${Date.now()}@example.com`, name: 'Typ User' })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'typst-test', engine: 'typst', ownerId: user.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.typ',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, '= Hello\n\nWorld.\n');
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const enqueue = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    const { job_id: jobId } = (await enqueue.json()) as { job_id: string };

    const deadline = Date.now() + 60_000;
    let status: CompileStatusJson | null = null;
    while (Date.now() < deadline) {
      const r = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile/${jobId}`, {
        headers: { cookie },
      });
      status = (await r.json()) as CompileStatusJson;
      if (status.status === 'success' || status.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!status || status.status !== 'success') {
      throw new Error(`compile did not succeed: ${JSON.stringify(status)}`);
    }
    expect(status.synctex_url).toBeNull();

    const sx = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile/${jobId}/synctex`, {
      headers: { cookie },
    });
    expect(sx.status).toBe(404);
  }, 180_000);
});
