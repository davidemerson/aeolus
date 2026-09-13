import { describe, expect, it } from 'vitest';

import { createTestDb } from '@aeolus/shared';

import {
  assertCanRead,
  assertCanWrite,
  DocArchivedError,
  DocForbiddenError,
  DocNotFoundError,
  resolveRole,
  type AclDeps,
} from './acl.js';

function makeFixture() {
  const testDb = createTestDb();
  const alice = testDb.addUser({ email: 'alice@example.com', isAdmin: false });
  const bob = testDb.addUser({ email: 'bob@example.com', isAdmin: false });
  const carol = testDb.addUser({ email: 'carol@example.com', isAdmin: false });
  const dave = testDb.addUser({ email: 'dave@example.com', isAdmin: false });
  const root = testDb.addUser({ email: 'root@example.com', isAdmin: true });

  const doc = testDb.addDoc({
    title: 'Alice paper',
    engine: 'latex',
    ownerId: alice.id,
  });

  testDb.addCollaborator({ docId: doc.id, userId: bob.id, role: 'editor' });
  testDb.addCollaborator({ docId: doc.id, userId: carol.id, role: 'viewer' });

  const deps: AclDeps = testDb;

  return { testDb, deps, alice, bob, carol, dave, root, doc };
}

describe('resolveRole', () => {
  it('returns owner for the document owner', async () => {
    const fx = makeFixture();
    await expect(resolveRole(fx.deps, fx.alice.id, fx.doc.id)).resolves.toBe('owner');
  });

  it('returns editor for an editor collaborator', async () => {
    const fx = makeFixture();
    await expect(resolveRole(fx.deps, fx.bob.id, fx.doc.id)).resolves.toBe('editor');
  });

  it('returns viewer for a viewer collaborator', async () => {
    const fx = makeFixture();
    await expect(resolveRole(fx.deps, fx.carol.id, fx.doc.id)).resolves.toBe('viewer');
  });

  it('returns none for a non-member', async () => {
    const fx = makeFixture();
    await expect(resolveRole(fx.deps, fx.dave.id, fx.doc.id)).resolves.toBe('none');
  });

  it('returns owner for an admin regardless of row membership', async () => {
    const fx = makeFixture();
    await expect(resolveRole(fx.deps, fx.root.id, fx.doc.id)).resolves.toBe('owner');
  });

  it('returns owner for an admin even on a soft-deleted doc', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(resolveRole(fx.deps, fx.root.id, fx.doc.id)).resolves.toBe('owner');
  });

  it('returns none for the owner once the doc is soft-deleted', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(resolveRole(fx.deps, fx.alice.id, fx.doc.id)).resolves.toBe('none');
  });

  it('returns none for a collaborator once the doc is soft-deleted', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(resolveRole(fx.deps, fx.bob.id, fx.doc.id)).resolves.toBe('none');
    await expect(resolveRole(fx.deps, fx.carol.id, fx.doc.id)).resolves.toBe('none');
  });

  it('returns none for an unknown user', async () => {
    const fx = makeFixture();
    await expect(
      resolveRole(fx.deps, '00000000-0000-4000-8000-000000000000', fx.doc.id),
    ).resolves.toBe('none');
  });

  it('returns none for an unknown doc', async () => {
    const fx = makeFixture();
    await expect(
      resolveRole(fx.deps, fx.alice.id, '00000000-0000-4000-8000-000000000000'),
    ).resolves.toBe('none');
  });

  it('returns none for a malformed doc id without hitting the db', async () => {
    const fx = makeFixture();
    let dbCalls = 0;
    const spied: AclDeps = {
      async getUser(id) {
        dbCalls++;
        return fx.deps.getUser(id);
      },
      async getDoc(id) {
        dbCalls++;
        return fx.deps.getDoc(id);
      },
      async getCollaboratorRole(docId, userId) {
        dbCalls++;
        return fx.deps.getCollaboratorRole(docId, userId);
      },
    };
    await expect(resolveRole(spied, fx.alice.id, 'not-a-uuid')).resolves.toBe('none');
    expect(dbCalls).toBe(0);
  });
});

describe('assertCanRead', () => {
  it('allows owner, editor, viewer, and admin and returns the loaded doc', async () => {
    const fx = makeFixture();
    // assertCanRead returns the AclDocRow it loaded (callers like
    // compile.ts and assets.ts use this to skip a redundant SELECT).
    await expect(assertCanRead(fx.deps, fx.alice.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
      ownerId: fx.alice.id,
    });
    await expect(assertCanRead(fx.deps, fx.bob.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
    await expect(assertCanRead(fx.deps, fx.carol.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
    await expect(assertCanRead(fx.deps, fx.root.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
  });

  it('throws DocNotFoundError for a non-member', async () => {
    const fx = makeFixture();
    await expect(assertCanRead(fx.deps, fx.dave.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  it('throws DocNotFoundError for a non-admin on a soft-deleted doc', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(assertCanRead(fx.deps, fx.alice.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
    await expect(assertCanRead(fx.deps, fx.bob.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  it('allows admin on a soft-deleted doc', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(assertCanRead(fx.deps, fx.root.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
      deletedAt: expect.any(Date),
    });
  });
});

describe('assertCanWrite', () => {
  it('allows owner, editor, and admin and returns the loaded doc', async () => {
    const fx = makeFixture();
    await expect(assertCanWrite(fx.deps, fx.alice.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
    await expect(assertCanWrite(fx.deps, fx.bob.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
    await expect(assertCanWrite(fx.deps, fx.root.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
  });

  it('throws DocForbiddenError for a viewer', async () => {
    const fx = makeFixture();
    await expect(assertCanWrite(fx.deps, fx.carol.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocForbiddenError,
    );
  });

  it('throws DocNotFoundError for a non-member (does not leak existence)', async () => {
    const fx = makeFixture();
    await expect(assertCanWrite(fx.deps, fx.dave.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  it('throws DocNotFoundError for a non-admin writer on a soft-deleted doc', async () => {
    const fx = makeFixture();
    fx.testDb.softDeleteDoc(fx.doc.id);
    await expect(assertCanWrite(fx.deps, fx.bob.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  it('throws DocArchivedError for owner, editor, and admin on an archived doc', async () => {
    const fx = makeFixture();
    fx.testDb.archiveDoc(fx.doc.id);
    await expect(assertCanWrite(fx.deps, fx.alice.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocArchivedError,
    );
    await expect(assertCanWrite(fx.deps, fx.bob.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocArchivedError,
    );
    await expect(assertCanWrite(fx.deps, fx.root.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocArchivedError,
    );
  });

  it('still rejects viewer on an archived doc with DocForbiddenError (not DocArchivedError)', async () => {
    // Role check runs first — a viewer never had write access in the
    // first place; archive state is irrelevant for them.
    const fx = makeFixture();
    fx.testDb.archiveDoc(fx.doc.id);
    await expect(assertCanWrite(fx.deps, fx.carol.id, fx.doc.id)).rejects.toBeInstanceOf(
      DocForbiddenError,
    );
  });
});

describe('archive does not gate reads', () => {
  it('archived doc is still readable by collaborators', async () => {
    const fx = makeFixture();
    fx.testDb.archiveDoc(fx.doc.id);
    await expect(assertCanRead(fx.deps, fx.alice.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
      archivedAt: expect.any(Date),
    });
    await expect(assertCanRead(fx.deps, fx.bob.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
    await expect(assertCanRead(fx.deps, fx.carol.id, fx.doc.id)).resolves.toMatchObject({
      id: fx.doc.id,
    });
  });
});
