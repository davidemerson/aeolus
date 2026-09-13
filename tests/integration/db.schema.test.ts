import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '@aeolus/db/migrate';

interface ExpectedColumn {
  name: string;
  dataType: string;
  isNullable?: boolean;
}

const expected: Record<string, ExpectedColumn[]> = {
  users: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'email', dataType: 'text', isNullable: false },
    { name: 'name', dataType: 'text', isNullable: true },
    { name: 'is_admin', dataType: 'boolean', isNullable: false },
    { name: 'anthropic_consent_at', dataType: 'timestamp with time zone', isNullable: true },
    { name: 'disabled_at', dataType: 'timestamp with time zone', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  sessions: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'user_id', dataType: 'uuid', isNullable: false },
    { name: 'token_hash', dataType: 'text', isNullable: false },
    { name: 'expires_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'last_seen_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'user_agent', dataType: 'text', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  templates: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'name', dataType: 'text', isNullable: false },
    { name: 'description', dataType: 'text', isNullable: true },
    { name: 'engine', dataType: 'text', isNullable: false },
    { name: 'thumbnail_key', dataType: 'text', isNullable: true },
    { name: 'is_published', dataType: 'boolean', isNullable: false },
    { name: 'yjs_doc_id', dataType: 'uuid', isNullable: false },
    { name: 'created_by', dataType: 'uuid', isNullable: true },
    { name: 'deleted_at', dataType: 'timestamp with time zone', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  docs: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'title', dataType: 'text', isNullable: false },
    { name: 'engine', dataType: 'text', isNullable: false },
    { name: 'owner_id', dataType: 'uuid', isNullable: false },
    { name: 'forked_from_template', dataType: 'uuid', isNullable: true },
    { name: 'is_template_doc', dataType: 'boolean', isNullable: false },
    { name: 'deleted_at', dataType: 'timestamp with time zone', isNullable: true },
    { name: 'archived_at', dataType: 'timestamp with time zone', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_collaborators: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'doc_id', dataType: 'uuid', isNullable: false },
    { name: 'user_id', dataType: 'uuid', isNullable: false },
    { name: 'role', dataType: 'text', isNullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_updates: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'yjs_doc_id', dataType: 'uuid', isNullable: false },
    { name: 'seq', dataType: 'bigint', isNullable: false },
    { name: 'update', dataType: 'bytea', isNullable: false },
    { name: 'author_id', dataType: 'uuid', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_snapshots: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'yjs_doc_id', dataType: 'uuid', isNullable: false },
    { name: 'snapshot_seq', dataType: 'bigint', isNullable: false },
    { name: 'snapshot_key', dataType: 'text', isNullable: false },
    { name: 'bytes', dataType: 'bigint', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_checkpoints: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'yjs_doc_id', dataType: 'uuid', isNullable: false },
    { name: 'label', dataType: 'text', isNullable: false },
    { name: 'snapshot_key', dataType: 'text', isNullable: false },
    { name: 'created_by', dataType: 'uuid', isNullable: true },
    { name: 'kind', dataType: 'text', isNullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_files: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'doc_id', dataType: 'uuid', isNullable: false },
    { name: 'path', dataType: 'text', isNullable: false },
    { name: 'kind', dataType: 'text', isNullable: false },
    { name: 'yjs_doc_id', dataType: 'uuid', isNullable: true },
    { name: 'storage_key', dataType: 'text', isNullable: true },
    { name: 'filename', dataType: 'text', isNullable: true },
    { name: 'mime_type', dataType: 'text', isNullable: true },
    { name: 'size_bytes', dataType: 'integer', isNullable: true },
    { name: 'uploaded_by', dataType: 'uuid', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_project_checkpoints: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'doc_id', dataType: 'uuid', isNullable: false },
    { name: 'label', dataType: 'text', isNullable: false },
    { name: 'created_by', dataType: 'uuid', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  doc_project_checkpoint_blobs: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'project_checkpoint_id', dataType: 'uuid', isNullable: false },
    { name: 'path', dataType: 'text', isNullable: false },
    { name: 'storage_key', dataType: 'text', isNullable: false },
    { name: 'filename', dataType: 'text', isNullable: true },
    { name: 'mime_type', dataType: 'text', isNullable: true },
    { name: 'size_bytes', dataType: 'integer', isNullable: true },
    { name: 'uploaded_by', dataType: 'uuid', isNullable: true },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  ai_requests: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'user_id', dataType: 'uuid', isNullable: false },
    { name: 'doc_id', dataType: 'uuid', isNullable: false },
    { name: 'input_tokens', dataType: 'integer', isNullable: false },
    { name: 'output_tokens', dataType: 'integer', isNullable: false },
    { name: 'cached_input_tokens', dataType: 'integer', isNullable: false },
    { name: 'cost_usd_cents', dataType: 'integer', isNullable: false },
    { name: 'instruction', dataType: 'text', isNullable: false },
    { name: 'status', dataType: 'text', isNullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  ai_quota: [
    { name: 'id', dataType: 'uuid', isNullable: false },
    { name: 'user_id', dataType: 'uuid', isNullable: false },
    { name: 'per_hour', dataType: 'integer', isNullable: false },
    { name: 'per_day', dataType: 'integer', isNullable: false },
    { name: 'tokens_per_day', dataType: 'integer', isNullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
  ai_global_spend: [
    { name: 'day_utc', dataType: 'date', isNullable: false },
    { name: 'total_cents', dataType: 'integer', isNullable: false },
    { name: 'created_at', dataType: 'timestamp with time zone', isNullable: false },
    { name: 'updated_at', dataType: 'timestamp with time zone', isNullable: false },
  ],
};

describe('db schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('aeolus_test')
      .withUsername('aeolus')
      .withPassword('aeolus')
      .start();
    const connectionString = container.getConnectionUri();
    await runMigrations(connectionString);
    pool = new pg.Pool({ connectionString });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  for (const [table, columns] of Object.entries(expected)) {
    describe(`table ${table}`, () => {
      it('exists in public schema', async () => {
        const { rows } = await pool.query<{ count: string }>(
          `select count(*)::text as count
             from information_schema.tables
            where table_schema = 'public' and table_name = $1`,
          [table],
        );
        expect(rows[0]?.count).toBe('1');
      });

      it('has the expected columns', async () => {
        const { rows } = await pool.query<{
          column_name: string;
          data_type: string;
          is_nullable: 'YES' | 'NO';
        }>(
          `select column_name, data_type, is_nullable
             from information_schema.columns
            where table_schema = 'public' and table_name = $1`,
          [table],
        );
        const byName = new Map(rows.map((r) => [r.column_name, r]));
        for (const col of columns) {
          const actual = byName.get(col.name);
          expect(actual, `${table}.${col.name} missing`).toBeDefined();
          expect(actual!.data_type, `${table}.${col.name} type`).toBe(col.dataType);
          if (col.isNullable !== undefined) {
            const nullable = actual!.is_nullable === 'YES';
            expect(nullable, `${table}.${col.name} nullable`).toBe(col.isNullable);
          }
        }
      });
    });
  }

  it('uses gen_random_uuid without requiring the pgcrypto extension', async () => {
    // Per ADR 0010, the migration runner does NOT install pgcrypto:
    // the runtime role lacks rds_superuser, and Postgres 13+ ships
    // gen_random_uuid in core. The migration was previously emitting
    // CREATE EXTENSION pgcrypto from drizzle-kit, which crashed
    // first-deploy on RDS. Assert the absence + that the function
    // we actually use still resolves.
    const { rows: ext } = await pool.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'pgcrypto'`,
    );
    expect(ext.length).toBe(0);
    const { rows: fn } = await pool.query<{ uuid: string }>(
      `select gen_random_uuid()::text as uuid`,
    );
    expect(fn[0]!.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // Asserts each index name is present in pg_indexes so a migration
  // that creates one cannot land without the corresponding schema.ts
  // declaration, and a future drizzle introspection cannot silently
  // drop one. Originally seeded with the migration-0009 hot-path
  // indexes; expanded as part of issue #51 to cover every named
  // index across migrations 0003-0024 that schema.ts now declares,
  // so the schema.ts ↔ migration drift this test was meant to catch
  // actually gets caught.
  const expectedIndexes: ReadonlyArray<readonly [table: string, indexName: string]> = [
    // 0003 (table create)
    ['compile_results', 'compile_results_doc_id_idx'],
    // 0007 (ws_tickets create)
    ['ws_tickets', 'ws_tickets_expires_at_idx'],
    ['ws_tickets', 'ws_tickets_user_doc_idx'],
    // 0009 hot-path indexes
    ['doc_collaborators', 'doc_collaborators_user_id_idx'],
    ['ai_requests', 'ai_requests_user_created_at_idx'],
    ['doc_checkpoints', 'doc_checkpoints_yjs_doc_id_created_at_idx'],
    ['sessions', 'sessions_expires_at_idx'],
    ['sessions', 'sessions_last_seen_at_idx'],
    ['compile_results', 'compile_results_status_created_at_idx'],
    // 0020 partial index (archived-only filter)
    ['docs', 'docs_archived_at_idx'],
    // 0024 backs GET /docs/:id/synctex/latest
    ['compile_results', 'compile_results_doc_id_created_at_idx'],
  ];
  for (const [table, indexName] of expectedIndexes) {
    it(`has ${indexName} on ${table}`, async () => {
      const { rows } = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from pg_indexes
          where schemaname = 'public' and tablename = $1 and indexname = $2`,
        [table, indexName],
      );
      expect(rows[0]?.count, `${indexName} missing on ${table}`).toBe('1');
    });
  }
});
