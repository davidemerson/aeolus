import { GetObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev session failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('Failed to parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

async function uploadAsset(
  baseUrl: string,
  userId: string,
  docId: string,
  filename: string,
  data: Buffer,
): Promise<Response> {
  const cookie = await freshCookie(baseUrl, userId);
  const form = new FormData();
  form.append('file', new Blob([data]), filename);
  return fetch(`${baseUrl}/api/docs/${docId}/assets`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
}

async function asJson(
  baseUrl: string,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const cookie = await freshCookie(baseUrl, userId);
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface CompileStatusJson {
  job_id: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  pdf_key: string | null;
  pdf_url: string | null;
  error: string | null;
}

async function collectBody(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('asset upload + compile with asset', () => {
  let fx: CompileFixtures;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('uploads a 1x1 PNG, verifies S3, compiles LaTeX with includegraphics', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({ email: `asset-${Date.now()}@example.com`, name: 'Asset User' })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({ title: 'asset-compile-test', engine: 'latex', ownerId: user.id })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.tex',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const uploadRes = await uploadAsset(fx.apiBaseUrl, user.id, doc.id, 'image.png', PNG_1X1);
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as {
      asset: { id: string; filename: string; size_bytes: number };
    };
    expect(uploadBody.asset.filename).toBe('image.png');
    expect(uploadBody.asset.size_bytes).toBe(PNG_1X1.length);

    const listRes = await asJson(fx.apiBaseUrl, user.id, 'GET', `/docs/${doc.id}/assets`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      assets: { id: string; filename: string }[];
    };
    expect(listBody.assets).toHaveLength(1);
    expect(listBody.assets[0].filename).toBe('image.png');

    const LATEX_WITH_IMAGE = [
      '\\documentclass{article}',
      '\\usepackage{graphicx}',
      '\\begin{document}',
      'Hello with image!',
      '\\includegraphics{image.png}',
      '\\end{document}',
    ].join('\n');

    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, LATEX_WITH_IMAGE);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    const compileRes = await asJson(fx.apiBaseUrl, user.id, 'POST', `/docs/${doc.id}/compile`);
    expect(compileRes.status).toBe(202);
    const compileBody = (await compileRes.json()) as { job_id: string };

    // Poll the job until it reaches a terminal state (helpers/poll.ts;
    // the worker's own budget is the 60 s deadline).
    const status = await waitFor(
      async () => {
        const res = await asJson(
          fx.apiBaseUrl,
          user.id,
          'GET',
          `/docs/${doc.id}/compile/${compileBody.job_id}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as CompileStatusJson;
        return body.status === 'success' || body.status === 'failed' ? body : null;
      },
      { timeoutMs: 60_000, intervalMs: 500, label: 'compile terminal state' },
    );

    if (!status || status.status !== 'success') {
      throw new Error(`compile did not succeed: ${JSON.stringify(status, null, 2)}`);
    }
    expect(status.pdf_key).toBeTruthy();
    expect(status.error).toBeNull();

    const obj = await fx.s3Client.send(
      new GetObjectCommand({ Bucket: fx.bucket, Key: status.pdf_key ?? '' }),
    );
    expect(obj.Body).toBeTruthy();
    const pdf = await collectBody(obj.Body as AsyncIterable<Uint8Array>);
    expect(pdf.length).toBeGreaterThan(1024);
    expect(pdf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  }, 180_000);
});
