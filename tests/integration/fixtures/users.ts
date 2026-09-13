import { users, type Database } from '@aeolus/db';

export interface SeededUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}

export async function seedAdminUser(
  db: Database,
  overrides: { email?: string; name?: string } = {},
): Promise<SeededUser> {
  const email =
    overrides.email ?? `admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: overrides.name ?? 'Admin User',
      isAdmin: true,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
    });
  return row;
}

export async function seedStandardUser(
  db: Database,
  overrides: { email?: string; name?: string } = {},
): Promise<SeededUser> {
  const email =
    overrides.email ?? `user-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: overrides.name ?? null,
      isAdmin: false,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
    });
  return row;
}
