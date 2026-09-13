import { GetObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';

const TYPST_SOURCE = '= Hello, world\n';

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev session failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

async function as(
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
  doc_id: string;
  engine: 'latex' | 'typst';
  status: 'queued' | 'running' | 'success' | 'failed';
  rev: string;
  pdf_key: string | null;
  pdf_url: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

async function collectBody(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('compile pipeline (typst)', () => {
  let fx: CompileFixtures;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('compiles a seeded typst document into a non-empty PDF stored in S3', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({
        email: `typst-${Date.now()}@example.com`,
        name: 'Typst User',
      })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({
        title: 'typst-compile-test',
        engine: 'typst',
        ownerId: user.id,
      })
      .returning({ id: docs.id });
    await fx.db.insert(docFiles).values({
      docId: doc.id,
      path: 'main.typ',
      kind: 'text',
      yjsDocId: doc.id,
    });

    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, TYPST_SOURCE);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const crdtDeps: CrdtDeps = { db: fx.db, blobs: fx.blobs };
    await persistUpdate(crdtDeps, doc.id, 0n, update, user.id);

    const compileRes = await as(fx.apiBaseUrl, user.id, 'POST', `/docs/${doc.id}/compile`);
    expect(compileRes.status).toBe(202);
    const compileBody = (await compileRes.json()) as {
      job_id: string;
      rev: string;
      status: string;
    };
    expect(compileBody.status).toBe('queued');

    // Poll the job until it reaches a terminal state (helpers/poll.ts;
    // the worker's own budget is the 60 s deadline).
    const status = await waitFor(
      async () => {
        const res = await as(
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
      throw new Error(`typst compile did not succeed: ${JSON.stringify(status, null, 2)}`);
    }
    expect(status.pdf_key).toBe(`compiled/${doc.id}/${compileBody.rev}.pdf`);

    const obj = await fx.s3Client.send(
      new GetObjectCommand({ Bucket: fx.bucket, Key: status.pdf_key ?? '' }),
    );
    const pdf = await collectBody(obj.Body as AsyncIterable<Uint8Array>);
    expect(pdf.length).toBeGreaterThan(1024);
    expect(pdf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  }, 180_000);
});
