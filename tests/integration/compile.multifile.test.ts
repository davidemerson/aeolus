import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';

const SOURCE_WITH_NESTED_IMAGE = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Hello \\
\includegraphics[width=10pt]{images/dot.png}
\end{document}`;

// 1×1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

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

describe('compile pipeline (multi-file) — issue #9 phase 2', () => {
  let fx: CompileFixtures;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('compiles a doc that references a sub-folder asset (images/dot.png)', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `mf-${Date.now()}@example.com`, name: 'Multi File User' })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({
        title: 'multi-file-test',
        engine: 'latex',
        ownerId: user.id,
      })
      .returning({ id: docs.id });

    // Phase-1 dual-write that the API would have done if the doc
    // were created via POST /docs.
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    // Stage the source via the existing per-doc Yjs persistence
    // (yjs_doc_id == docs.id for this row).
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, SOURCE_WITH_NESTED_IMAGE);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    // Stage the asset at images/dot.png by writing the blob and a
    // doc_files row directly. The HTTP asset upload always writes
    // a bare filename today; phase 3 will add a "create file at
    // path" API. For phase-2 verification we only need the worker
    // to honour an existing nested path.
    const storageKey = `assets/${doc.id}/${crypto.randomUUID()}.png`;
    await fx.blobs.put(storageKey, PNG_1X1);
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'images/dot.png',
      kind: 'blob',
      storageKey,
      filename: 'dot.png',
      mimeType: 'image/png',
      sizeBytes: PNG_1X1.length,
    });

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const enqueue = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(enqueue.status).toBe(202);
    const { job_id: jobId } = (await enqueue.json()) as { job_id: string };

    const final = await waitFor(
      async () => {
        const r = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile/${jobId}`, {
          headers: { cookie },
        });
        const body = (await r.json()) as {
          status: string;
          error: string | null;
          pdf_url: string | null;
        };
        return body.status === 'success' || body.status === 'failed' ? body : null;
      },
      { timeoutMs: 60_000, intervalMs: 500, label: 'compile terminal state' },
    );
    expect(final, 'compile reached terminal state').not.toBeNull();
    if (final!.status !== 'success') {
      throw new Error(`compile failed: ${final!.error ?? 'unknown'}`);
    }

    // PDF was produced and stored. The graphicx \\includegraphics
    // resolves to images/dot.png from the workdir, so the worker
    // must have materialized the asset at that nested path. Fetch
    // the bytes from S3 directly (the status route returns a
    // presigned URL via the test fixture's presignCompiledPdf hook;
    // an absolute URL means we don't prepend the api host).
    const pdfRes = await fetch(final!.pdf_url!);
    expect(pdfRes.status).toBe(200);
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(1024);
  }, 240_000);

  it('compiles a doc whose main.tex \\input{}s a sibling text file (#36 / #44)', async () => {
    // The worker has to materialise every kind='text' row in the
    // project, not just the entrypoint — otherwise \input{frontmatter}
    // 404s in the compile workdir even though frontmatter.tex exists
    // in doc_files. This test pins that behavior.
    const [user] = await fx.db
      .insert(users)
      .values({
        email: `mf-input-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
        name: 'Sibling Input User',
      })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'sibling-input-test', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });

    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });
    const frontmatterYjsDocId = crypto.randomUUID();
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'frontmatter.tex',
      kind: 'text',
      yjsDocId: frontmatterYjsDocId,
    });

    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };

    const mainSource = String.raw`\documentclass{article}
\input{frontmatter}
\begin{document}
\maketitle
Body.
\end{document}`;
    const main = new Y.Doc();
    main.getText('source').insert(0, mainSource);
    await persistUpdate(crdtDeps, doc.id, 0n, Y.encodeStateAsUpdate(main), user.id);
    main.destroy();

    const frontmatterSource = String.raw`\title{Hello from a sibling file}
\author{Aeolus}
\date{2026}`;
    const front = new Y.Doc();
    front.getText('source').insert(0, frontmatterSource);
    await persistUpdate(crdtDeps, frontmatterYjsDocId, 0n, Y.encodeStateAsUpdate(front), user.id);
    front.destroy();

    const cookie = await freshCookie(fx.apiBaseUrl, user.id);
    const enqueue = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(enqueue.status).toBe(202);
    const { job_id: jobId } = (await enqueue.json()) as { job_id: string };

    const final = await waitFor(
      async () => {
        const r = await fetch(`${fx.apiBaseUrl}/api/docs/${doc.id}/compile/${jobId}`, {
          headers: { cookie },
        });
        const body = (await r.json()) as {
          status: string;
          error: string | null;
          pdf_url: string | null;
        };
        return body.status === 'success' || body.status === 'failed' ? body : null;
      },
      { timeoutMs: 60_000, intervalMs: 500, label: 'compile terminal state' },
    );
    expect(final).not.toBeNull();
    if (final!.status !== 'success') {
      throw new Error(`compile failed: ${final!.error ?? 'unknown'}`);
    }
    const pdfRes = await fetch(final!.pdf_url!);
    expect(pdfRes.status).toBe(200);
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(1024);
  }, 240_000);
});
