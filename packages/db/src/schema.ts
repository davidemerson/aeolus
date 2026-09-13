import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  name: text('name'),
  // scrypt hash of the passphrase (packages/auth/src/passphrase.ts), in the
  // form `scrypt$N$r$p$salt$hash`. NULL only for a user an admin created who
  // has not been given a credential yet — such a user cannot sign in.
  passphraseHash: text('passphrase_hash'),
  passphraseSetAt: timestamp('passphrase_set_at', { withTimezone: true }),
  // True while the current credential is one the system generated: the
  // bootstrap credential at first launch, or an admin reset. The caller can
  // sign in with it, but every route except the passphrase-setup endpoint
  // answers 403 until they choose their own.
  mustSetPassphrase: boolean('must_set_passphrase').notNull().default(false),
  // Throttling for the login route. Reset to 0 on any successful sign-in.
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  isAdmin: boolean('is_admin').notNull().default(false),
  anthropicConsentAt: timestamp('anthropic_consent_at', { withTimezone: true }),
  // Soft-disable. When set, resolveUser short-circuits to "not
  // authenticated" so the user's existing sessions are effectively
  // dead from the moment an admin flips the bit. Re-enabling
  // (admins set to NULL) restores access without re-onboarding.
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    // Long-lived operator sessions skip the rotate-on-touch behavior
    // so a single token can be reused across many calls. See migration
    // 0008 and createBotSession below.
    disableRotation: boolean('disable_rotation').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_expires_at_idx').on(t.expiresAt),
    index('sessions_last_seen_at_idx').on(t.lastSeenAt),
  ],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    description: text('description'),
    engine: text('engine').notNull(),
    thumbnailKey: text('thumbnail_key'),
    isPublished: boolean('is_published').notNull().default(false),
    yjsDocId: uuid('yjs_doc_id')
      .notNull()
      .unique()
      .references((): AnyPgColumn => docs.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('templates_engine_check', sql`${t.engine} in ('latex','typst')`)],
);

export const docs = pgTable(
  'docs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: text('title').notNull(),
    engine: text('engine').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    isTemplateDoc: boolean('is_template_doc').notNull().default(false),
    forkedFromTemplate: uuid('forked_from_template').references((): AnyPgColumn => templates.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('docs_engine_check', sql`${t.engine} in ('latex','typst')`),
    // Partial index: dominant query is the archived-only filter once
    // the docs table grows. Active-only filter is fast enough via the
    // small table size + updated_at sort.
    index('docs_archived_at_idx')
      .on(t.archivedAt)
      .where(sql`${t.archivedAt} IS NOT NULL`),
  ],
);

export const docCollaborators = pgTable(
  'doc_collaborators',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('doc_collaborators_doc_user_unique').on(t.docId, t.userId),
    check('doc_collaborators_role_check', sql`${t.role} in ('viewer','editor')`),
    index('doc_collaborators_user_id_idx').on(t.userId),
  ],
);

// Yjs storage: keyed by yjs_doc_id (a doc_files row's identifier),
// not by docs.id. ADR 0013 retargeted the FK from
// docs to doc_files so multi-file projects can mint fresh
// yjs_doc_ids per text file. Phase-1-backfilled rows have
// yjs_doc_id == docs.id; phase-3 file creation generates new UUIDs.
export const docUpdates = pgTable(
  'doc_updates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    yjsDocId: uuid('yjs_doc_id')
      .notNull()
      .references((): AnyPgColumn => docFiles.yjsDocId, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    update: bytea('update').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('doc_updates_yjs_doc_id_seq_unique').on(t.yjsDocId, t.seq)],
);

export const docSnapshots = pgTable('doc_snapshots', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  yjsDocId: uuid('yjs_doc_id')
    .notNull()
    .unique()
    .references((): AnyPgColumn => docFiles.yjsDocId, { onDelete: 'cascade' }),
  snapshotSeq: bigint('snapshot_seq', { mode: 'bigint' }).notNull(),
  snapshotKey: text('snapshot_key').notNull(),
  // Byte length of the snapshot blob — populated by snapshotDoc().
  // NULL on old rows written without it; the next compaction
  // backfills. Read by GET /docs/:id/files to give text files a
  // size in the file panel without an S3 HEAD per row.
  bytes: bigint('bytes', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Project-wide checkpoints. One row per project snapshot; the
// per-file doc_checkpoints rows that compose it carry the
// matching project_checkpoint_id. See the FK
// shape + cascade behaviour, and apps/api/src/routes/
// project-checkpoints.ts for the routes.
export const docProjectCheckpoints = pgTable(
  'doc_project_checkpoints',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // `.nullsFirst()` is not decoration. Drizzle's bare `.desc()` emits
  // `DESC NULLS LAST`, and Postgres will not use such an index to answer
  // `ORDER BY x DESC` — which means NULLS FIRST — so every list query that
  // this index exists for falls back to a sequential scan and a sort. It is
  // spelled out on every descending index in this file for the same reason.
  (t) => [
    index('doc_project_checkpoints_doc_id_created_at_idx').on(
      t.docId,
      t.createdAt.desc().nullsFirst(),
    ),
  ],
);

// Blob-state snapshot for project checkpoints. One row per blob
// in the project at checkpoint time; restore wipes current blob
// doc_files rows and re-inserts from this set. The S3 objects
// are referenced, not copied; the asset-delete path checks this
// table before S3 delete so referenced keys survive.
export const docProjectCheckpointBlobs = pgTable(
  'doc_project_checkpoint_blobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectCheckpointId: uuid('project_checkpoint_id')
      .notNull()
      .references(() => docProjectCheckpoints.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('doc_project_checkpoint_blobs_project_path_unique').on(t.projectCheckpointId, t.path),
    index('doc_project_checkpoint_blobs_storage_key_idx').on(t.storageKey),
  ],
);

export const docCheckpoints = pgTable(
  'doc_checkpoints',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    yjsDocId: uuid('yjs_doc_id')
      .notNull()
      .references((): AnyPgColumn => docFiles.yjsDocId, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    snapshotKey: text('snapshot_key').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    // When non-null, this checkpoint is one slice of a project-wide
    // snapshot identified by docProjectCheckpoints.id. Per-file
    // checkpoints (created via /docs/:id/checkpoints) leave it
    // null and stay addressable as before. CASCADE so deleting
    // a project checkpoint drops the per-file rows that compose
    // it.
    projectCheckpointId: uuid('project_checkpoint_id').references(() => docProjectCheckpoints.id, {
      onDelete: 'cascade',
    }),
    // 'user' for explicit user-named checkpoints (the original kind);
    // 'auto_open' for snapshots written when a user opens a file
    // (subject to 5-min per-user coalescing and a 30-day retention
    // sweep).
    kind: text('kind').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('doc_checkpoints_yjs_doc_id_created_at_idx').on(
      t.yjsDocId,
      t.createdAt.desc().nullsFirst(),
    ),
    index('doc_checkpoints_project_checkpoint_id_idx').on(t.projectCheckpointId),
    index('doc_checkpoints_kind_created_at_idx').on(t.kind, t.createdAt),
    check('doc_checkpoints_kind_check', sql`${t.kind} in ('user','auto_open')`),
  ],
);

export const compileResults = pgTable(
  'compile_results',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull().unique(),
    engine: text('engine').notNull(),
    rev: bigint('rev', { mode: 'bigint' }).notNull(),
    status: text('status').notNull(),
    pdfKey: text('pdf_key'),
    // Parsed-synctex JSON blob key (LaTeX only; null for typst and
    // for compiles where parsing failed). See
    // apps/api/src/synctex.ts for the JSON shape.
    synctexKey: text('synctex_key'),
    error: text('error'),
    // Non-fatal findings on a successful compile — fonts the PDF references
    // but does not embed (#80). JSON array of author-facing strings; null
    // NULL on failed compiles and on rows written before the column existed.
    warnings: jsonb('warnings').$type<string[]>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('compile_results_engine_check', sql`${t.engine} in ('latex','typst')`),
    check(
      'compile_results_status_check',
      sql`${t.status} in ('queued','running','success','failed')`,
    ),
    index('compile_results_status_created_at_idx').on(t.status, t.createdAt),
    // Single-column docId
    // lookups (e.g. recent compiles for a doc, irrespective of status)
    // use this; the (doc_id, created_at DESC) composite below covers
    // the more selective synctex/latest query.
    index('compile_results_doc_id_idx').on(t.docId),
    // Backs GET /docs/:id/synctex/latest (apps/api/src/routes/compile.ts)
    // — filters compile_results by docId, ordered by createdAt DESC.
    // The status_created_at_idx above leads with status, so docId-first
    // queries fall back to a sequential scan as compile history grows.
    index('compile_results_doc_id_created_at_idx').on(t.docId, t.createdAt.desc().nullsFirst()),
  ],
);

// Multi-file project storage. Each docs row is logically a project;
// its individual files (one or more .tex sources, plus binary
// assets) live here. Phase 1 of issue #9 backfills this from the
// existing single-source + doc_assets shape and dual-writes from
// the API; phase 2 has the worker read from it.
export const docFiles = pgTable(
  'doc_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: text('kind').notNull(),
    // Phase 1: yjs_doc_id is always docs.id (the existing per-doc
    // Yjs key) so doc_updates / doc_snapshots already address the
    // text file's content. Phase 3 may assign synthetic UUIDs for
    // additional .tex files; see ADR 0013.
    yjsDocId: uuid('yjs_doc_id'),
    storageKey: text('storage_key'),
    filename: text('filename'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('doc_files_doc_id_path_unique').on(t.docId, t.path),
    // Three tables carry a foreign key to this column — doc_updates,
    // doc_snapshots and doc_checkpoints — and Postgres will not accept a
    // foreign key to a column that is not unique.
    unique('doc_files_yjs_doc_id_unique').on(t.yjsDocId),
    check('doc_files_kind_check', sql`${t.kind} in ('text','blob','folder')`),
    check(
      'doc_files_kind_payload_check',
      sql`(${t.kind} = 'text' AND ${t.yjsDocId} IS NOT NULL AND ${t.storageKey} IS NULL)
          OR
          (${t.kind} = 'blob' AND ${t.storageKey} IS NOT NULL AND ${t.yjsDocId} IS NULL)
          OR
          (${t.kind} = 'folder' AND ${t.yjsDocId} IS NULL AND ${t.storageKey} IS NULL)`,
    ),
    index('doc_files_doc_id_idx').on(t.docId),
  ],
);

// Blob storage lives in doc_files (kind='blob'). See ADR 0013.

export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    costUsdCents: integer('cost_usd_cents').notNull(),
    instruction: text('instruction').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_requests_user_created_at_idx').on(t.userId, t.createdAt)],
);

export const aiQuota = pgTable('ai_quota', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  perHour: integer('per_hour').notNull().default(30),
  perDay: integer('per_day').notNull().default(200),
  tokensPerDay: integer('tokens_per_day').notNull().default(50000),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiGlobalSpend = pgTable('ai_global_spend', {
  dayUtc: date('day_utc', { mode: 'string' }).primaryKey(),
  totalCents: integer('total_cents').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// A single-row table for admin-managed settings. Nothing reads it today: the
// one setting it ever held was an email-domain allow-list for the invitation
// flow, which was retired when an administrator started creating accounts
// directly. Kept, rather than dropped, so the next setting that needs to live
// in the database has somewhere to go without a migration to create a table.
export const appSettings = pgTable(
  'app_settings',
  {
    id: text('id')
      .primaryKey()
      .default(sql`'singleton'`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  // One row, enforced. Without this a second row is insertable and every
  // reader has to decide which one wins.
  (t) => [check('app_settings_singleton_check', sql`${t.id} = 'singleton'`)],
);

// Audit log: chronological record of auth + major mutation events
// (logins, user CRUD, doc CRUD, template CRUD, doc opens, etc.).
// 30-day retention enforced by the list endpoint sweeping older
// rows on every admin read — see apps/api/src/audit.ts and ADR
// 0015. CloudTrail / external mirroring is a separate follow-up.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    // null when the actor is unauthenticated (failed login, the
    // founder bootstrap call before any user exists, system tasks).
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // Captured at event time so the log survives later user
    // deletions / email rename. NULL for unauth events.
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_events_occurred_at_idx').on(t.occurredAt.desc().nullsFirst()),
    index('audit_events_actor_id_occurred_at_idx').on(t.actorId, t.occurredAt.desc().nullsFirst()),
    index('audit_events_action_occurred_at_idx').on(t.action, t.occurredAt.desc().nullsFirst()),
  ],
);

/**
 * Bearer credentials for the `/api/v1` machine plane.
 *
 * Sessions cannot serve this purpose: `touch()` rotates the session token on
 * every authenticated request, so a client that ignores `Set-Cookie` gets
 * exactly one request per credential. These do not rotate.
 *
 * One property worth stating out loud: a token acts as the user who
 * minted it, so `created_by` is load-bearing authorization input, not
 * provenance.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    // 16 hex chars — the token's PUBLIC half AND this table's primary key, so
    // verifying a presented credential is one indexed lookup plus a
    // constant-time compare rather than a scan over every live row.
    // Deliberately text, not uuid: it is half of a credential string and has
    // to round-trip the wire format byte for byte.
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // sha256 of the WHOLE presented token, hex. The plaintext is shown once at
    // creation and stored nowhere — not recoverable by anyone, including an
    // operator with database access. A plain sha256 rather than a KDF is right
    // here precisely because the input is 256 bits of uniform randomness, not
    // a human-chosen password.
    tokenHash: text('token_hash').notNull(),
    // 'read' (RFC 9110 safe methods only) or 'write' (the whole plane).
    // Default 'read': there are no pre-existing rows to
    // protect from a silent downgrade, so least privilege applies from row one
    // and the two-step ADD-COLUMN-then-SET-DEFAULT dance is unnecessary.
    scope: text('scope').notNull().default('read'),
    // CASCADE, not SET NULL, and not optional: a token acts AS this user, so a
    // row without one would be a credential with no authority to resolve.
    // Deleting the user must therefore revoke their tokens.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Captured at mint time so a revoke can still name the owner after the
    // account is gone — the same durability argument as audit_events.actor_email.
    createdByEmail: text('created_by_email'),
    // Stamped at most once per token per 5 minutes, in SQL, so three racing api
    // tasks do not fight over the row. Approximate by design: its job is to
    // make "is anything still using this?" answerable before someone revokes.
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('api_tokens_scope_check', sql`${t.scope} in ('read','write')`),
    index('api_tokens_created_at_idx').on(t.createdAt.desc().nullsFirst()),
    index('api_tokens_created_by_idx').on(t.createdBy),
  ],
);

export const wsTickets = pgTable(
  'ws_tickets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ticketHash: text('ticket_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // expires_at backs the mint-time sweep of stale
    // rows and the TTL gate in the upgrade's UPDATE…WHERE (the lookup
    // itself is by ticket_hash). ws_tickets_user_doc_idx is a
    // leftover from the original single-use design — no current query
    // uses it; dropping it would be a migration, not worth one.
    index('ws_tickets_expires_at_idx').on(t.expiresAt),
    index('ws_tickets_user_doc_idx').on(t.userId, t.docId),
  ],
);
