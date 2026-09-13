import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aeolus:aeolus@localhost:5432/aeolus',
  },
  strict: true,
  verbose: true,
} satisfies Config;
