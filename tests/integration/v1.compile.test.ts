import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryMailAdapter, buildServer } from '@aeolus/api';
import { MemoryBlobStore } from '@aeolus/crdt';
import { compileResults, db as makeDb, docs, docFiles, users, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';

import { parseSetCookie } from './helpers/cookies.js';

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const PDF_BYTES = '%PDF-1.7\n%fake\n';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  baseUrl: string;
  db: Database;
  blobs: MemoryBlobStore;
  close(): Promise<void>;
}

async function setup(): Promise<Fixtures> {
  process.env.NODE_ENV = 'test';
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);
  const { db, pool } = makeDb({ connectionString });
  const blobs = new MemoryBlobStore();
  // No compileBoss: the worker is a separate process and is not under test
  // here. What IS under test is everything around it — auth, status, the
  // 204-vs-404 choices, the bytes, and the zip.
  const app = await buildServer({
    db,
    blobs,
    cookieSecret: 'v1-compile-test-secret',
    mail: new MemoryMailAdapter(),
    publicBaseUrl: 'http://localhost:5173',
    cookieSecure: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return {
    postgres,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    blobs,
    async close() {
      await app.close();
      await pool.end();
      await postgres.stop();
    },
  };
}

let fx: Fixtures;
beforeAll(async () => {
  fx = await setup();
}, 180_000);
afterAll(async () => {
  await fx?.close();
});

let seq = 0;
async function persona(isAdmin = false) {
  const email = `v1cmp-${Date.now()}-${seq++}@example.com`;
  const [user] = await fx.db.insert(users).values({ email, isAdmin }).returning({ id: users.id });
  const sess = await fetch(`${fx.baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  const c = parseSetCookie(sess.headers.get('set-cookie') ?? '')!;
  const cookie = `${c.name}=${c.value}`;
  const mint = async (scope: 'read' | 'write') =>
    (
      await json<{ token: string }>(
        await fetch(`${fx.baseUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: `${scope}-${seq}`, scope }),
        }),
      )
    ).token;
  return { userId: user.id, email, read: await mint('read'), write: await mint('write') };
}

function v1(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${fx.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

let owner: Awaited<ReturnType<typeof persona>>;
async function seedDoc(): Promise<string> {
  owner ??= await persona(false);
  const [doc] = await fx.db
    .insert(docs)
    .values({ title: `cmp-${seq++}`, engine: 'latex', ownerId: owner.userId })
    .returning({ id: docs.id });
  await fx.db
    .insert(docFiles)
    .values({ docId: doc.id, path: 'main.tex', kind: 'text', yjsDocId: doc.id });
  return doc.id;
}

async function seedCompile(
  docId: string,
  opts: {
    status?: string;
    withPdf?: boolean;
    withSynctex?: boolean;
    // undefined leaves the column null, as pre-0028 rows are.
    warnings?: string[];
  } = {},
) {
  const jobId = `job-${seq++}-${Date.now()}`;
  const status = opts.status ?? 'success';
  const pdfKey = opts.withPdf === false ? null : `compiled/${docId}/${jobId}.pdf`;
  const synctexKey = opts.withSynctex ? `compiled/${docId}/${jobId}.synctex.json` : null;
  if (pdfKey) await fx.blobs.put(pdfKey, Buffer.from(PDF_BYTES));
  if (synctexKey) await fx.blobs.put(synctexKey, Buffer.from('{"pages":[]}'));
  await fx.db.insert(compileResults).values({
    docId,
    jobId,
    engine: 'latex',
    rev: 1n,
    status,
    pdfKey: status === 'success' ? pdfKey : null,
    synctexKey: status === 'success' ? synctexKey : null,
    finishedAt: status === 'success' || status === 'failed' ? new Date() : null,
    error: status === 'failed' ? '! Undefined control sequence.' : null,
    warnings: opts.warnings,
  });
  return jobId;
}

const FONT_WARNING =
  'Font "IosevkaCustomXYZW-Regular" is not embedded in the PDF — it will display as blank or substituted text on any machine that does not have it installed.';

describe('/api/v1 compile — status and results', () => {
  it('reports a successful compile with a usable download url', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId, { withSynctex: true });

    const view = await json<Record<string, unknown>>(
      await v1(owner.read, `/docs/${docId}/compile/${jobId}`),
    );
    expect(view).toMatchObject({
      job_id: jobId,
      doc_id: docId,
      status: 'success',
      pdf_url: `/docs/${docId}/compile/${jobId}/download`,
      synctex_url: `/docs/${docId}/compile/${jobId}/synctex`,
      error: null,
    });
  });

  // #80: the worker records non-embedded fonts on a SUCCESSFUL compile.
  // A machine caller publishing PDFs needs to see them, and an old row with
  // a null column must read as "no warnings", not as a missing field.
  it('round-trips compile warnings, and renders a null column as an empty array', async () => {
    const docId = await seedDoc();
    const warned = await seedCompile(docId, { warnings: [FONT_WARNING] });
    const view = await json<{ status: string; warnings: string[] }>(
      await v1(owner.read, `/docs/${docId}/compile/${warned}`),
    );
    expect(view.status).toBe('success');
    expect(view.warnings).toEqual([FONT_WARNING]);

    const latest = await json<{ job_id: string; warnings: string[] }>(
      await v1(owner.read, `/docs/${docId}/compile/latest`),
    );
    expect(latest.job_id).toBe(warned);
    expect(latest.warnings).toEqual([FONT_WARNING]);

    const legacyDoc = await seedDoc();
    const legacy = await seedCompile(legacyDoc);
    const legacyView = await json<{ warnings: string[] }>(
      await v1(owner.read, `/docs/${legacyDoc}/compile/${legacy}`),
    );
    expect(legacyView.warnings).toEqual([]);
  });

  it('carries the engine log on failure, which is what CI wants to print', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId, { status: 'failed' });
    const view = await json<{ status: string; error: string; pdf_url: string | null }>(
      await v1(owner.read, `/docs/${docId}/compile/${jobId}`),
    );
    expect(view.status).toBe('failed');
    expect(view.error).toContain('Undefined control sequence');
    expect(view.pdf_url).toBeNull();
  });

  it('404s a job id belonging to another document', async () => {
    const a = await seedDoc();
    const b = await seedDoc();
    const jobId = await seedCompile(a);
    expect((await v1(owner.read, `/docs/${b}/compile/${jobId}`)).status).toBe(404);
  });

  it('204s /compile/latest when nothing has ever compiled', async () => {
    const docId = await seedDoc();
    const res = await v1(owner.read, `/docs/${docId}/compile/latest`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns the newest success from /compile/latest, ignoring failures', async () => {
    const docId = await seedDoc();
    await seedCompile(docId, { status: 'failed' });
    const good = await seedCompile(docId);
    await seedCompile(docId, { status: 'failed' });

    const latest = await json<{ job_id: string; is_current: boolean }>(
      await v1(owner.read, `/docs/${docId}/compile/latest`),
    );
    expect(latest.job_id).toBe(good);
  });

  // is_current is what lets a client skip a rebuild, so a wrong TRUE is the
  // expensive direction — it would hand back a stale PDF as the answer.
  it('flips is_current to false once the project changes', async () => {
    const docId = await seedDoc();
    await seedCompile(docId);
    expect(
      (await json<{ is_current: boolean }>(await v1(owner.read, `/docs/${docId}/compile/latest`)))
        .is_current,
    ).toBe(true);

    // A sibling file — which `rev` cannot see, because rev is MAX(seq) of the
    // MAIN file's CRDT only.
    await v1(owner.write, `/docs/${docId}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: 'chapter2.tex' }),
    });

    expect(
      (await json<{ is_current: boolean }>(await v1(owner.read, `/docs/${docId}/compile/latest`)))
        .is_current,
    ).toBe(false);
  });
});

describe('/api/v1 compile — bytes', () => {
  it('streams the PDF, and honours ?inline=1', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId);

    const res = await v1(owner.read, `/docs/${docId}/compile/${jobId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('%PDF-');

    const inline = await v1(owner.read, `/docs/${docId}/compile/${jobId}/download?inline=1`);
    expect(inline.headers.get('content-disposition')).toContain('inline');
  });

  it('404s the download for a failed compile', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId, { status: 'failed' });
    expect((await v1(owner.read, `/docs/${docId}/compile/${jobId}/download`)).status).toBe(404);
  });

  it('204s /synctex/latest but 404s a named job with no map', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId, { withSynctex: false });

    // "No map" is normal — every Typst document, forever — so the latest
    // route says 204 rather than logging an error on every editor mount.
    expect((await v1(owner.read, `/docs/${docId}/synctex/latest`)).status).toBe(204);
    // But you named a specific job, so "it has none" is an answer about it.
    expect((await v1(owner.read, `/docs/${docId}/compile/${jobId}/synctex`)).status).toBe(404);
  });

  it('serves the synctex map when there is one', async () => {
    const docId = await seedDoc();
    const jobId = await seedCompile(docId, { withSynctex: true });
    for (const path of [
      `/docs/${docId}/synctex/latest`,
      `/docs/${docId}/compile/${jobId}/synctex`,
    ]) {
      const res = await v1(owner.read, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).toContain('pages');
    }
  });
});

describe('/api/v1 project zip', () => {
  it('bundles text rendered from its CRDT alongside blob bytes', async () => {
    const docId = await seedDoc();
    const main = (
      await json<{ files: Array<{ id: string; path: string }> }>(
        await v1(owner.read, `/docs/${docId}/files`),
      )
    ).files.find((f) => f.path === 'main.tex')!;
    await v1(owner.write, `/docs/${docId}/files/${main.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: '\\documentclass{article}' }),
    });
    const form = new FormData();
    form.append('path', 'fig.png');
    form.append('file', new Blob([Buffer.from('PNGBYTES')], { type: 'image/png' }), 'fig.png');
    await fetch(`${fx.baseUrl}/api/v1/docs/${docId}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.write}` },
      body: form,
    });

    const res = await v1(owner.read, `/docs/${docId}/download.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('.zip');

    const zip = Buffer.from(await res.arrayBuffer());
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    // Names and payloads are stored uncompressed by buildZip, so both are
    // greppable in the raw archive.
    expect(zip.includes(Buffer.from('main.tex'))).toBe(true);
    expect(zip.includes(Buffer.from('fig.png'))).toBe(true);
    expect(zip.includes(Buffer.from('\\documentclass{article}'))).toBe(true);
    expect(zip.includes(Buffer.from('PNGBYTES'))).toBe(true);
  });
});

describe('/api/v1 compile — access', () => {
  it('503s an enqueue when no compile queue is configured, rather than pretending', async () => {
    const docId = await seedDoc();
    const res = await v1(owner.write, `/docs/${docId}/compile`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect((await json<{ error: string }>(res)).error).toBe('compile_unavailable');
  });

  it('refuses an enqueue from a read token before it reaches the queue', async () => {
    const docId = await seedDoc();
    const res = await v1(owner.read, `/docs/${docId}/compile`, { method: 'POST' });
    // 403, not the 503 above: the scope gate runs first.
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('read_only_token');
  });

  it('hides everything from an outsider', async () => {
    const outsider = await persona(false);
    const docId = await seedDoc();
    const jobId = await seedCompile(docId);
    for (const path of [
      `/docs/${docId}/compile/latest`,
      `/docs/${docId}/compile/${jobId}`,
      `/docs/${docId}/compile/${jobId}/download`,
      `/docs/${docId}/synctex/latest`,
      `/docs/${docId}/download.zip`,
    ]) {
      expect((await v1(outsider.read, path)).status, path).toBe(404);
    }
  });
});
