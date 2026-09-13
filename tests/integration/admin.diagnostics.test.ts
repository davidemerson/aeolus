import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { users } from '@aeolus/db';

import { setupCompileFixtures, type CompileFixtures } from './helpers/compile-fixtures.js';
import { parseSetCookie } from './helpers/cookies.js';

async function freshCookie(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/dev/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (res.status !== 201) throw new Error(`dev session ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no set-cookie');
  const parsed = parseSetCookie(setCookie);
  if (!parsed) throw new Error('parse set-cookie');
  return `${parsed.name}=${parsed.value}`;
}

describe('admin diagnostics', () => {
  let fx: CompileFixtures;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    fx = await setupCompileFixtures();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const [a] = await fx.db
      .insert(users)
      .values({ email: `diag-admin-${suffix}@example.com`, isAdmin: true })
      .returning({ id: users.id });
    const [u] = await fx.db
      .insert(users)
      .values({ email: `diag-user-${suffix}@example.com`, isAdmin: false })
      .returning({ id: users.id });
    adminId = a.id;
    userId = u.id;
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('GET /admin/diagnostics is admin-only', async () => {
    const noCookie = await fetch(`${fx.apiBaseUrl}/api/admin/diagnostics`);
    expect(noCookie.status).toBe(401);

    const userCookie = await freshCookie(fx.apiBaseUrl, userId);
    const userRes = await fetch(`${fx.apiBaseUrl}/api/admin/diagnostics`, {
      headers: { cookie: userCookie },
    });
    expect(userRes.status).toBe(403);

    const adminCookie = await freshCookie(fx.apiBaseUrl, adminId);
    const adminRes = await fetch(`${fx.apiBaseUrl}/api/admin/diagnostics`, {
      headers: { cookie: adminCookie },
    });
    expect(adminRes.status).toBe(200);
    const body = (await adminRes.json()) as {
      ts: string;
      queue: { queue?: string } | { error: string };
      compiles: { recent_total: number };
      compile_boss_attached: boolean;
    };
    expect(typeof body.ts).toBe('string');
    expect(body.compile_boss_attached).toBe(true);
    expect(body.compiles).toHaveProperty('recent_total');
    if ('queue' in body.queue) {
      expect(body.queue.queue).toBe('aeolus.compile');
    }
  });

  it('POST /admin/diagnostics/compile runs a smoke compile end-to-end', async () => {
    const adminCookie = await freshCookie(fx.apiBaseUrl, adminId);
    const res = await fetch(`${fx.apiBaseUrl}/api/admin/diagnostics/compile`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      doc_id: string;
      job_id: string;
      status: string;
      elapsed_ms: number | null;
      pdf_key: string | null;
      error: string | null;
      persistence: {
        local_text_length: number;
        local_update_bytes: number;
        persisted_rows: number;
        persisted_update_bytes: number;
        api_loaded_source_length: number;
      };
    };

    expect(body.ok).toBe(true);
    expect(body.status).toBe('success');
    expect(body.pdf_key).toMatch(new RegExp(`^compiled/${body.doc_id}/1\\.pdf$`));
    expect(body.error).toBeNull();
    expect(body.elapsed_ms).not.toBeNull();
    expect(body.elapsed_ms).toBeLessThan(60_000);

    // Persistence self-check: api wrote bytes and read back the
    // same source length it inserted.
    expect(body.persistence.local_text_length).toBeGreaterThan(0);
    expect(body.persistence.persisted_rows).toBe(1);
    expect(body.persistence.persisted_update_bytes).toBe(body.persistence.local_update_bytes);
    expect(body.persistence.api_loaded_source_length).toBe(body.persistence.local_text_length);

    // The smoke doc must be soft-deleted so it doesn't pile up on
    // /docs every time the operator runs the diagnostic.
    const { rows } = await fx.dbPool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM docs WHERE id = $1',
      [body.doc_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  }, 90_000);

  it('POST /admin/diagnostics/compile is admin-only', async () => {
    const userCookie = await freshCookie(fx.apiBaseUrl, userId);
    const res = await fetch(`${fx.apiBaseUrl}/api/admin/diagnostics/compile`, {
      method: 'POST',
      headers: { cookie: userCookie },
    });
    expect(res.status).toBe(403);
  });
});
