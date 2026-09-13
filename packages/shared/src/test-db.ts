import { randomUUID } from 'node:crypto';

export interface TestUserRow {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}

export interface TestDocRow {
  id: string;
  title: string;
  engine: 'latex' | 'typst';
  ownerId: string;
  deletedAt: Date | null;
  archivedAt: Date | null;
  isTemplateDoc: boolean;
}

export interface TestCollaboratorRow {
  docId: string;
  userId: string;
  role: 'editor' | 'viewer';
}

export interface AddUserInput {
  id?: string;
  email: string;
  name?: string | null;
  isAdmin?: boolean;
}

export interface AddDocInput {
  id?: string;
  title: string;
  engine: 'latex' | 'typst';
  ownerId: string;
  deletedAt?: Date | null;
  archivedAt?: Date | null;
  isTemplateDoc?: boolean;
}

export class TestDb {
  readonly users = new Map<string, TestUserRow>();
  readonly docs = new Map<string, TestDocRow>();
  readonly collaborators: TestCollaboratorRow[] = [];

  addUser(input: AddUserInput): TestUserRow {
    const row: TestUserRow = {
      id: input.id ?? randomUUID(),
      email: input.email,
      name: input.name ?? null,
      isAdmin: input.isAdmin ?? false,
    };
    this.users.set(row.id, row);
    return row;
  }

  addDoc(input: AddDocInput): TestDocRow {
    const row: TestDocRow = {
      id: input.id ?? randomUUID(),
      title: input.title,
      engine: input.engine,
      ownerId: input.ownerId,
      deletedAt: input.deletedAt ?? null,
      archivedAt: input.archivedAt ?? null,
      isTemplateDoc: input.isTemplateDoc ?? false,
    };
    this.docs.set(row.id, row);
    return row;
  }

  archiveDoc(docId: string, at: Date = new Date()): void {
    const row = this.docs.get(docId);
    if (row) {
      this.docs.set(docId, { ...row, archivedAt: at });
    }
  }

  addCollaborator(input: TestCollaboratorRow): TestCollaboratorRow {
    const existing = this.collaborators.findIndex(
      (c) => c.docId === input.docId && c.userId === input.userId,
    );
    if (existing >= 0) {
      this.collaborators[existing] = input;
    } else {
      this.collaborators.push(input);
    }
    return input;
  }

  softDeleteDoc(docId: string, at: Date = new Date()): void {
    const row = this.docs.get(docId);
    if (row) {
      this.docs.set(docId, { ...row, deletedAt: at });
    }
  }

  async getUser(userId: string): Promise<{ id: string; isAdmin: boolean } | null> {
    const row = this.users.get(userId);
    return row ? { id: row.id, isAdmin: row.isAdmin } : null;
  }

  async getDoc(docId: string): Promise<{
    id: string;
    ownerId: string;
    deletedAt: Date | null;
    archivedAt: Date | null;
    isTemplateDoc: boolean;
    engine: string;
  } | null> {
    const row = this.docs.get(docId);
    return row
      ? {
          id: row.id,
          ownerId: row.ownerId,
          deletedAt: row.deletedAt,
          archivedAt: row.archivedAt,
          isTemplateDoc: row.isTemplateDoc,
          engine: row.engine,
        }
      : null;
  }

  async getCollaboratorRole(docId: string, userId: string): Promise<'editor' | 'viewer' | null> {
    const row = this.collaborators.find((c) => c.docId === docId && c.userId === userId);
    return row ? row.role : null;
  }
}

export function createTestDb(): TestDb {
  return new TestDb();
}
