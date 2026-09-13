# 0013 — Per-file Yjs persistence: re-target the FK from `docs` to `doc_files`

- **Status**: accepted
- **Date**: 2026-05-01
- **Deciders**: davidemerson

## Context

Phase 1 of issue #9 added `doc_files (doc_id, path, kind, yjs_doc_id,
storage_key, …)`. The migration backfilled every existing doc with a
single `kind='text'` row at `main.{tex,typ}` whose `yjs_doc_id`
equals `docs.id`. Phase 2 has the compile worker read from this
table, with the entrypoint's `yjs_doc_id` driving `loadDoc(...)`.

Phase 3 lights up multi-file editing in the UI. Users will create
additional `.tex` files (`chapters/intro.tex`, etc.). Each text file
needs its own Yjs doc — that's the point of multi-file editing,
otherwise edits in one file would mutate another. So phase 3 has to
mint fresh `yjs_doc_id` UUIDs for new text files, and the existing
Yjs persistence layer (`doc_updates`, `doc_snapshots`,
`doc_checkpoints`) needs to address rows by `yjs_doc_id` instead of
hard-coding `docs.id`.

The current FKs on those tables target `docs.id`:

```
doc_updates.doc_id     → docs.id (CASCADE)
doc_snapshots.doc_id   → docs.id (CASCADE, UNIQUE — one snapshot/doc)
doc_checkpoints.doc_id → docs.id (CASCADE)
```

A new text file's `yjs_doc_id` is *not* a `docs.id`, so the existing
FK constraint would reject any insert.

## Options considered

### Option A — Drop the FK, rename column, app-level cascade

- Drop the FK on each of the three tables.
- Rename the column from `doc_id` to `yjs_doc_id` for clarity.
- App code becomes responsible for deleting `doc_updates` /
  `doc_snapshots` / `doc_checkpoints` rows when a `doc_files` text
  row is deleted (and again when its parent `docs` row is deleted).

Pros: Cleanest column naming. `doc_updates` becomes "Yjs storage"
rather than "doc storage."

Cons: Loses cascade-on-delete safety net. A miss in app code
silently leaves orphan rows. The hot-path indexes still apply,
because `(doc_id, seq)` on `doc_updates` was already keyed on the
column we're renaming.

### Option B — Re-target the FK to `doc_files.yjs_doc_id`

- Add a UNIQUE constraint on `doc_files.yjs_doc_id` (only
  non-null values are checked, since `'blob'` rows have NULL).
- Drop the existing FK from each table to `docs.id`.
- Rename `doc_id` → `yjs_doc_id` on each of the three tables.
- Add a new FK to `doc_files.yjs_doc_id` ON DELETE CASCADE.

Pros: Cascade-on-delete still works. `doc_files` row goes away →
its Yjs storage cascades. `docs` row goes away → existing
`doc_files.doc_id → docs.id` CASCADE FK kicks in, deleting
`doc_files`, which then cascades to Yjs storage.

Cons: Two-hop cascade is slightly more work for Postgres on a doc
delete (delete from `docs` → cascade through `doc_files` →
cascade through `doc_updates` and friends). Acceptable.

### Option C — Keep the FK, mint a `docs` row per text file

- Each new text file is a new `docs` row with `is_template_doc=false`
  and some "child of" pointer. Stores `yjs_doc_id == new_docs.id`.

Pros: Zero schema change on the persistence tables.

Cons: Pollutes the `docs` table with internal-only rows that aren't
real documents. ACL / listing / templates code all has to learn to
filter them out (similar to the existing `is_template_doc` carve-out
but with much more surface area). Adds a column. Big mental model
hit.

## Decision

**Option B — re-target the FK from `docs.id` to
`doc_files.yjs_doc_id`.**

Keeps cascade semantics, models the actual ownership relationship
("Yjs storage belongs to a file, not a doc"), and avoids polluting
`docs` with non-document rows.

## Implementation plan (phase 3)

### Schema migration

```sql
-- 1. Make doc_files.yjs_doc_id UNIQUE so it can be a FK target.
--    NULLs ('blob' rows) are allowed; Postgres treats multiple NULLs
--    as distinct per the SQL standard.
ALTER TABLE doc_files
  ADD CONSTRAINT doc_files_yjs_doc_id_unique UNIQUE (yjs_doc_id);

-- 2. doc_updates: rename column and re-target FK.
ALTER TABLE doc_updates
  DROP CONSTRAINT doc_updates_doc_id_docs_id_fk;
ALTER TABLE doc_updates
  RENAME COLUMN doc_id TO yjs_doc_id;
ALTER TABLE doc_updates
  ADD CONSTRAINT doc_updates_yjs_doc_id_doc_files_fk
  FOREIGN KEY (yjs_doc_id) REFERENCES doc_files(yjs_doc_id) ON DELETE CASCADE;

-- 3. Same for doc_snapshots (and update its UNIQUE to match).
ALTER TABLE doc_snapshots
  DROP CONSTRAINT doc_snapshots_doc_id_docs_id_fk,
  DROP CONSTRAINT doc_snapshots_doc_id_unique;
ALTER TABLE doc_snapshots
  RENAME COLUMN doc_id TO yjs_doc_id;
ALTER TABLE doc_snapshots
  ADD CONSTRAINT doc_snapshots_yjs_doc_id_doc_files_fk
  FOREIGN KEY (yjs_doc_id) REFERENCES doc_files(yjs_doc_id) ON DELETE CASCADE,
  ADD CONSTRAINT doc_snapshots_yjs_doc_id_unique UNIQUE (yjs_doc_id);

-- 4. Same for doc_checkpoints.
ALTER TABLE doc_checkpoints
  DROP CONSTRAINT doc_checkpoints_doc_id_docs_id_fk;
ALTER TABLE doc_checkpoints
  RENAME COLUMN doc_id TO yjs_doc_id;
ALTER TABLE doc_checkpoints
  ADD CONSTRAINT doc_checkpoints_yjs_doc_id_doc_files_fk
  FOREIGN KEY (yjs_doc_id) REFERENCES doc_files(yjs_doc_id) ON DELETE CASCADE;
-- Note: checkpoints are per-file in this model. A "snapshot the
-- whole project" feature is a separate, higher-level concept and
-- can be modelled as a meta-checkpoint that references one
-- checkpoint per file. Out of scope for phase 3.
```

The hot-path index `(doc_id, seq)` on `doc_updates` stays — Postgres
renames its column with the table when we rename. Same for
`doc_checkpoints_doc_id_created_at_idx`.

### App code changes (high-level)

- `packages/crdt/src/persist.ts`: rename the parameter from `docId`
  to `yjsDocId` everywhere. Internal — the CRDT helpers don't know
  about docs.
- `apps/api/src/routes/checkpoints.ts`: lookup the file by
  `(doc_id, path)` to get the `yjs_doc_id`, then call
  `persist`/`snapshot` with that id. Checkpoints become per-file.
- `apps/api/src/routes/compile.ts`: phase 2 already reads
  doc_files; just confirm `getDocCurrentSeq()` accepts a yjs_doc_id.
- `apps/ws/src/server.ts`: the upgrade URL now needs a `fileId`
  (or `path`) in addition to `docId`. ACL still gates on docId.
  The room key changes from docId to yjs_doc_id so multiple files
  in one project don't collide.
- `apps/web/src/routes/doc-editor.tsx`: file-tree sidebar; clicking
  a `.tex` file swaps the editor's Yjs binding. The
  `WebsocketProvider` URL now includes both docId (for ACL) and
  fileId (for the Yjs room).

### File-tree UI

- Sidebar lists every `doc_files` row, grouped by parent path.
- Click a `kind='text'` row → swap the editor binding to that
  file's `yjs_doc_id`.
- "New file" dialog: name (path) + kind (text/blob).
- Folder upload via `<input type="file" webkitdirectory>` +
  `DataTransferItem.webkitGetAsEntry`. Upload N files; each lands
  at its captured relative path; the API auto-derives the path
  parts and inserts at `doc_files`.

### Backwards compatibility

The migration is breaking-but-symmetric. Every existing
`doc_updates.doc_id` matches a `doc_files.yjs_doc_id` (because phase
1 backfilled `yjs_doc_id == docs.id` for the main file). The FK
re-targeting succeeds without a data scrub.

The drizzle ORM type for the column changes from `docId: uuid` to
`yjsDocId: uuid` — every callsite needs to update. This is a
mechanical refactor.

### Phase-4 cleanup (done)

- `doc_assets` was dropped; every blob lives in `doc_files` with
  `kind='blob'` and a `storage_key`.
- The per-blob metadata columns on `doc_files` (`filename`,
  `mime_type`, `size_bytes`, `uploaded_by`) were kept — the worker and
  the UI both want them.
- `doc_files.kind` later gained `'folder'`, so a folder is a row rather
  than an inference from a path separator. The
  `doc_files_kind_payload_check` constraint pins which payload column
  each kind may carry.

## Out of scope

- **Project-wide checkpoints.** The naive model is per-file; a
  "snapshot the whole project at this moment" is a separate
  feature.
- **Folder operations as first-class objects.** Out of scope for
  phase 3; a `'folder'` kind arrived later.
- **Cross-file references in version history.** "Restore the
  project to checkpoint X" needs to coordinate across multiple
  files, which the per-file checkpoint shape doesn't directly
  support. Defer.

## References

- Issue #9 — feat: multi-file LaTeX projects with folders + main.tex
  unification
- [`0011`](0011-latex-package-cache.md) — LaTeX package cache strategy
- [`0012`](0012-latex-engine-selection.md) — LaTeX engine selection
- The phase-1 `doc_files` schema + backfill, in the pre-publication
  migration history (see the note in [`README.md`](README.md))
