import { GetObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { persistUpdate, type CrdtDeps } from '@aeolus/crdt';
import { docFiles, docs, users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';
import { waitFor } from './helpers/poll.js';

const LATEX_SOURCE = '\\documentclass{article}\n\\begin{document}Hello, world!\\end{document}';

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) {
    throw new Error(`Failed to create dev session: ${res.status}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie returned from /dev/sessions');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('Failed to parse set-cookie');
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
  warnings: string[];
  started_at: string;
  finished_at: string | null;
}

async function collectBody(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('compile pipeline (latex)', () => {
  let fx: CompileFixtures;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('compiles a seeded latex document into a non-empty PDF stored in S3', async () => {
    const [user] = await fx.db
      .insert(users)
      .values({
        email: `latex-${Date.now()}@example.com`,
        name: 'Latex User',
      })
      .returning({ id: users.id });

    const [doc] = await fx.db
      .insert(docs)
      .values({
        title: 'latex-compile-test',
        engine: 'latex',
        ownerId: user.id,
      })
      .returning({ id: docs.id });
    // Tests bypass the API, so they have to mirror the API's
    // phase-1 dual-write of issue #9 (every doc gets a doc_files
    // 'text' source row pointing at the existing per-doc Yjs key).
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

    const compileRes = await as(fx.apiBaseUrl, user.id, 'POST', `/docs/${doc.id}/compile`);
    expect(compileRes.status).toBe(202);
    const compileBody = (await compileRes.json()) as {
      job_id: string;
      rev: string;
      status: string;
    };
    expect(compileBody.status).toBe('queued');
    expect(typeof compileBody.job_id).toBe('string');
    expect(compileBody.rev).toBe('0');

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
      throw new Error(`compile did not succeed: ${JSON.stringify(status, null, 2)}`);
    }
    expect(status.pdf_key).toBe(`compiled/${doc.id}/${compileBody.rev}.pdf`);
    // A stock article compile embeds every font it uses (#80).
    expect(status.warnings).toEqual([]);
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
