// Emit the generated OpenAPI description to stdout.
//
// Used two ways:
//   pnpm --filter @aeolus/api openapi:dump > docs/openapi.json   (regenerate)
//   the `openapi-drift` CI job                                   (verify)
//
// It boots the real server and fetches the real endpoint rather than calling
// `app.swagger()`, for two reasons. The decorator is not on the root instance —
// @fastify/swagger is registered INSIDE the encapsulated v1 plugin, so it
// decorates that scope only, which is the encapsulation doing its job. And
// going over HTTP means the committed artifact is exactly what a caller gets.
//
// No database is touched: buildServer only constructs a pg Pool, which does not
// connect until a query runs, and serving the description runs none. So this
// works with no services up — the same property that lets `db-drift` run
// without Postgres.
import { buildServer } from '../src/server.js';
import { MemoryMailAdapter } from '../src/mail.js';
import { MemoryBlobStore } from '@aeolus/crdt';
import { db as makeDb } from '@aeolus/db';

const { db, pool } = makeDb({
  connectionString: 'postgres://unused@127.0.0.1:1/unused',
});

const app = await buildServer({
  db,
  blobs: new MemoryBlobStore(),
  cookieSecret: 'x'.repeat(32),
  mail: new MemoryMailAdapter(),
  publicBaseUrl: 'https://aeolus.example.com',
  cookieSecure: true,
  logger: false,
});

await app.listen({ host: '127.0.0.1', port: 0 });
const { port } = app.server.address();

const res = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`);
if (!res.ok) {
  throw new Error(`openapi.json returned ${res.status}`);
}
process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`);

await app.close();
await pool.end();
