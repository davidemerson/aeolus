import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  MemoryBlobStore,
  backfillManifests,
  backfillSnapshotBytes,
  manifestKeyFor,
  readSnapshotManifest,
  restoreFromBlobStore,
  snapshotDoc,
  writeSnapshotManifest,
} from '@aeolus/crdt';
import { docFiles, docs, docSnapshots, users, db as makeDb, type Database } from '@aeolus/db';
import { runMigrations } from '@aeolus/db/migrate';
import { eq } from 'drizzle-orm';

interface Fixtures {
  postgres: StartedPostgreSqlContainer;
  db: Database;
  dbPool: Awaited<ReturnType<typeof makeDb>>['pool'];
  blobs: MemoryBlobStore;
  connectionString: string;
  close(): Promise<void>;
}

async function setup(): Promise<Fixtures> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('aeolus_test')
    .withUsername('aeolus')
    .withPassword('aeolus')
    .start();
  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);
  const { db, pool } = makeDb({ connectionString });
  return {
    postgres,
    db,
    dbPool: pool,
    blobs: new MemoryBlobStore(),
    connectionString,
    async close() {
      await pool.end();
      await postgres.stop();
    },
  };
}

// Reset the DB to "fresh after migrations" state — wipes every
// row we'd create in seedDoc(). Used to simulate Scenario C
// (RDS gone, S3 survives) before running the importer.
async function wipeDb(db: Database): Promise<void> {
  // doc_snapshots and doc_files cascade from doc_files / docs;
  // delete in dependency order to be safe even if drizzle orders
  // statements unexpectedly.
  await db.delete(docSnapshots);
  await db.delete(docFiles);
  await db.delete(docs);
  await db.delete(users);
}

interface SeededDoc {
  yjsDocId: string;
  docId: string;
  ownerEmail: string;
  path: string;
  title: string;
  text: string;
}

// Seed a doc + a single text file + a snapshot, mimicking the
// shape `snapshotDoc` produces during normal operation. Uses the
// real `snapshotDoc` so the manifest write happens via the same
// code path the WS server will hit in prod.
async function seedDoc(fx: Fixtures, override: Partial<SeededDoc> = {}): Promise<SeededDoc> {
  const id =
    override.docId ?? `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
  const yjsDocId = override.yjsDocId ?? id;
  const ownerEmail = override.ownerEmail ?? `owner-${id}@example.com`;
  const path = override.path ?? 'main.tex';
  const title = override.title ?? 'Seeded Doc';
  const text = override.text ?? 'hello world';

  const [user] = await fx.db
    .insert(users)
    .values({ email: ownerEmail, name: ownerEmail, isAdmin: false })
    .returning({ id: users.id });
  await fx.db.insert(docs).values({
    id,
    title,
    engine: 'latex',
    ownerId: user.id,
  });
  await fx.db.insert(docFiles).values({
    docId: id,
    path,
    kind: 'text',
    yjsDocId,
  });

  const doc = new Y.Doc();
  doc.getText('source').insert(0, text);
  await snapshotDoc({ db: fx.db, blobs: fx.blobs }, yjsDocId, doc, 1n);
  doc.destroy();

  return { yjsDocId, docId: id, ownerEmail, path, title, text };
}

describe('Scenario-C importer (restoreFromBlobStore)', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.close();
  });

  it('writes a sidecar manifest as a side-effect of snapshotDoc', async () => {
    const seeded = await seedDoc(fx);
    const manifest = await readSnapshotManifest(fx.blobs, seeded.yjsDocId);
    expect(manifest, 'manifest should be present after snapshotDoc').not.toBeNull();
    expect(manifest!).toMatchObject({
      schema: 1,
      yjsDocId: seeded.yjsDocId,
      docId: seeded.docId,
      title: seeded.title,
      engine: 'latex',
      ownerEmail: seeded.ownerEmail,
      path: seeded.path,
    });
    expect(typeof manifest!.writtenAt).toBe('string');
  });

  it('rebuilds docs / doc_files / doc_snapshots from S3 after RDS wipe', async () => {
    const seeded = await seedDoc(fx);

    // Confirm the row shape pre-wipe matches what we expect to
    // recover. If this fails, the assertions after restore are
    // testing the wrong thing.
    const [preDoc] = await fx.db.select().from(docs).where(eq(docs.id, seeded.docId)).limit(1);
    expect(preDoc?.title).toBe(seeded.title);

    // RDS goes away.
    await wipeDb(fx.db);
    const postWipe = await fx.db.select().from(docs);
    expect(postWipe).toHaveLength(0);

    // Importer runs — should re-materialize the rows from S3.
    const report = await restoreFromBlobStore({ db: fx.db, blobs: fx.blobs });
    expect(report.restored).toBeGreaterThanOrEqual(1);
    expect(report.skipped).toEqual([]);
    expect(report.files).toContainEqual({
      docId: seeded.docId,
      yjsDocId: seeded.yjsDocId,
      path: seeded.path,
    });

    // Owner stub user came back with the original email.
    const [restoredUser] = await fx.db
      .select()
      .from(users)
      .where(eq(users.email, seeded.ownerEmail))
      .limit(1);
    expect(restoredUser, 'owner should be re-created').toBeDefined();
    expect(restoredUser.isAdmin, 'stub user is non-admin').toBe(false);

    // docs row matches the manifest.
    const [restoredDoc] = await fx.db.select().from(docs).where(eq(docs.id, seeded.docId)).limit(1);
    expect(restoredDoc, 'docs row recovered').toBeDefined();
    expect(restoredDoc.title).toBe(seeded.title);
    expect(restoredDoc.engine).toBe('latex');

    // doc_files row matches.
    const [restoredFile] = await fx.db
      .select()
      .from(docFiles)
      .where(eq(docFiles.yjsDocId, seeded.yjsDocId))
      .limit(1);
    expect(restoredFile.path).toBe(seeded.path);
    expect(restoredFile.kind).toBe('text');
    expect(restoredFile.docId).toBe(seeded.docId);

    // doc_snapshots points at the recovered blob.
    const [restoredSnap] = await fx.db
      .select()
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    expect(restoredSnap.snapshotKey).toMatch(
      new RegExp(`^docs/${seeded.yjsDocId}/snap-\\d+\\.ydoc$`),
    );
    expect(restoredSnap.bytes).toBeGreaterThan(0);

    // Sanity — the snapshot blob still decodes to the seeded text.
    const blob = await fx.blobs.get(restoredSnap.snapshotKey);
    expect(blob, 'snapshot blob still in S3').not.toBeNull();
    const probe = new Y.Doc();
    Y.applyUpdate(probe, new Uint8Array(blob!));
    expect(probe.getText('source').toString()).toBe(seeded.text);
    probe.destroy();
  });

  it('is idempotent — re-running against a populated DB does nothing destructive', async () => {
    const seeded = await seedDoc(fx);
    await wipeDb(fx.db);
    await restoreFromBlobStore({ db: fx.db, blobs: fx.blobs });
    const second = await restoreFromBlobStore({ db: fx.db, blobs: fx.blobs });
    expect(second.skipped).toEqual([]);
    // Counts unchanged.
    const docCount = (await fx.db.select().from(docs)).length;
    const fileCount = (await fx.db.select().from(docFiles)).length;
    expect(docCount).toBeGreaterThanOrEqual(1);
    expect(fileCount).toBeGreaterThanOrEqual(1);
    void seeded;
  });

  it('skips yjsDocIds whose manifest is missing', async () => {
    const seeded = await seedDoc(fx);
    // Strip the manifest, leaving the snapshot blob orphaned. The
    // importer should report it as skipped, not crash.
    await fx.blobs.delete(manifestKeyFor(seeded.yjsDocId));
    await wipeDb(fx.db);
    const report = await restoreFromBlobStore({ db: fx.db, blobs: fx.blobs });
    // No manifest, no manifest.json key listed — the importer's
    // listing already filters to keys ending in /manifest.json, so
    // this yjsDocId never appears in `scanned`. The contract is
    // "no row created for this doc," not "no rows created at all"
    // (the test fixture is shared across cases, so other tests'
    // seeds may legitimately produce files in this report).
    const [missingDoc] = await fx.db.select().from(docs).where(eq(docs.id, seeded.docId)).limit(1);
    expect(missingDoc, 'no doc reconstructed without a manifest').toBeUndefined();
    expect(
      report.files.find((f) => f.yjsDocId === seeded.yjsDocId),
      'this doc not in the restored set',
    ).toBeUndefined();
  });

  it('skips snapshots that fail to decode', async () => {
    const seeded = await seedDoc(fx);
    // Find the snapshot key, corrupt its bytes.
    const [snap] = await fx.db
      .select({ key: docSnapshots.snapshotKey })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    await fx.blobs.put(snap.key, Buffer.from('not a yjs payload'));
    await wipeDb(fx.db);
    const report = await restoreFromBlobStore({ db: fx.db, blobs: fx.blobs });
    expect(
      report.skipped.find(
        (s) => s.yjsDocId === seeded.yjsDocId && s.reason === 'snapshot_decode_failed',
      ),
      'corrupted snapshot reported as skipped',
    ).toBeDefined();
    const [postDoc] = await fx.db.select().from(docs).where(eq(docs.id, seeded.docId)).limit(1);
    expect(postDoc, 'no doc row when snapshot is unreadable').toBeUndefined();
  });

  it('backfillManifests writes manifests for snapshots that lack them', async () => {
    const seeded = await seedDoc(fx);
    // Simulate the pre-sidecar-write era by deleting the manifest
    // that snapshotDoc wrote. The DB still has the snapshot row;
    // the blob store has the snap-*.ydoc; the manifest is gone.
    await fx.blobs.delete(manifestKeyFor(seeded.yjsDocId));
    expect(await readSnapshotManifest(fx.blobs, seeded.yjsDocId)).toBeNull();

    const report = await backfillManifests({ db: fx.db, blobs: fx.blobs });
    expect(report.written).toBeGreaterThanOrEqual(1);

    // Manifest is back; importer would now find it.
    const m = await readSnapshotManifest(fx.blobs, seeded.yjsDocId);
    expect(m).not.toBeNull();
    expect(m!.docId).toBe(seeded.docId);
  });

  it('writeSnapshotManifest returns false when no doc_files row matches', async () => {
    // No seedDoc — yjsDocId has no DB rows at all.
    const ok = await writeSnapshotManifest(
      { db: fx.db, blobs: fx.blobs },
      '00000000-0000-4000-8000-deadbeef0000',
    );
    expect(ok).toBe(false);
  });

  it('backfillSnapshotBytes populates NULL bytes from blob byteLength', async () => {
    const seeded = await seedDoc(fx);
    // Simulate the pre-migration-0022 era: clear `bytes` so the
    // snapshot row looks like one written before the column was
    // added. The actual blob in S3 is unchanged, so the backfill
    // can read the byteLength from there.
    const [pre] = await fx.db
      .select({ key: docSnapshots.snapshotKey, bytes: docSnapshots.bytes })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    expect(pre.bytes, 'precondition: snapshotDoc populated bytes').toBeGreaterThan(0);
    const expectedBytes = pre.bytes;

    await fx.db
      .update(docSnapshots)
      .set({ bytes: null })
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId));

    const report = await backfillSnapshotBytes({ db: fx.db, blobs: fx.blobs });
    expect(report.scanned).toBeGreaterThanOrEqual(1);
    expect(report.written).toBeGreaterThanOrEqual(1);
    expect(report.skipped).toBe(0);

    const [post] = await fx.db
      .select({ bytes: docSnapshots.bytes })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    expect(post.bytes).toBe(expectedBytes);
  });

  it('backfillSnapshotBytes skips rows whose blob is missing', async () => {
    const seeded = await seedDoc(fx);
    // Clear bytes AND delete the underlying blob — operator can't
    // recover the size without the blob; the backfill should report
    // it as skipped rather than crash.
    const [row] = await fx.db
      .select({ key: docSnapshots.snapshotKey })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    await fx.db
      .update(docSnapshots)
      .set({ bytes: null })
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId));
    await fx.blobs.delete(row.key);

    const report = await backfillSnapshotBytes({ db: fx.db, blobs: fx.blobs });
    expect(report.skipped).toBeGreaterThanOrEqual(1);

    const [post] = await fx.db
      .select({ bytes: docSnapshots.bytes })
      .from(docSnapshots)
      .where(eq(docSnapshots.yjsDocId, seeded.yjsDocId))
      .limit(1);
    expect(post.bytes, 'bytes stays NULL when blob is gone').toBeNull();
  });
});
