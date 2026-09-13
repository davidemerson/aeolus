import path from 'node:path';

export const COOKIE_SECRET = 'e2e-cookie-secret-do-not-use';

export const STATE_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '.stack-state.json',
);

export const WEB_ORIGIN = 'http://localhost:5173';
export const API_BASE = 'http://localhost:4000';
