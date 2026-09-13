export interface ApiError {
  error: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Whatever else the 4xx body carried. Services merge contract fields into
   * their error responses — `problems` on a rejected passphrase, `children` on
   * a non-empty folder — and this is where a caller reads them.
   */
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = 'ApiRequestError';
  }
}

// Fires once whenever any /api call comes back 401. The SPA root
// installs a handler that redirects to /login (see main.tsx); without
// this hook a stale session would surface as e.g. "Compile failed —
// Not signed in" inside whichever component made the request, instead
// of bouncing the user to login.
let unauthenticatedHandler: (() => void) | null = null;

export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  unauthenticatedHandler = fn;
}

// For the two callers that cannot go through `api` — the multipart upload
// and the AI SSE stream — so a 401 there still lands on /login like every
// other one.
export function reportUnauthenticated(): void {
  if (unauthenticatedHandler) unauthenticatedHandler();
}

// The same idea one status up: a user who has not replaced the credential the
// installer printed gets 403 passphrase_setup_required from every route except
// the setup ones. main.tsx sends them to /passphrase rather than letting the
// refusal surface as "Compile failed - passphrase setup required".
let passphraseSetupHandler: (() => void) | null = null;

export function setPassphraseSetupHandler(fn: (() => void) | null): void {
  passphraseSetupHandler = fn;
}

export const PASSPHRASE_SETUP_REQUIRED = 'passphrase_setup_required';

function reportError(err: ApiRequestError): ApiRequestError {
  if (err.status === 403 && err.code === PASSPHRASE_SETUP_REQUIRED && passphraseSetupHandler) {
    passphraseSetupHandler();
  }
  return err;
}

async function send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', ...init });
  if (res.status === 401) reportUnauthenticated();
  return res;
}

// Callers show `message` to people, so it is never an HTTP status word: a
// failure with no usable body gets a plain sentence.
const GENERIC_FAILURE = 'The request could not be completed.';

function toError(status: number, text: string): ApiRequestError {
  let data: Partial<ApiError> | undefined;
  try {
    data = text.length > 0 ? (JSON.parse(text) as Partial<ApiError>) : undefined;
  } catch {
    data = undefined;
  }
  const code = typeof data?.error === 'string' && data.error ? data.error : 'request_failed';
  const message =
    typeof data?.message === 'string' && data.message ? data.message : GENERIC_FAILURE;
  const { error: _error, message: _message, ...details } = (data ?? {}) as Record<string, unknown>;
  return new ApiRequestError(status, code, message, details);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, {
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw reportError(toError(res.status, text));
  return (text.length > 0 ? (JSON.parse(text) as unknown) : undefined) as T;
}

// Binary GET (checkpoint snapshots are raw Yjs updates, not JSON). Same
// cookie, same 401 handling, same error shape as the JSON methods.
async function getBytes(path: string): Promise<Uint8Array> {
  const res = await send('GET', path);
  if (!res.ok) throw reportError(toError(res.status, await res.text()));
  return new Uint8Array(await res.arrayBuffer());
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  getBytes,
};

export interface Me {
  user: {
    id: string;
    email: string;
    name: string | null;
    isAdmin: boolean;
    /**
     * Still signed in on a system-generated credential. Every API call except
     * the handful the setup screen needs answers 403 passphrase_setup_required
     * until this is false, so the SPA routes such a user straight to /passphrase.
     */
    mustSetPassphrase: boolean;
  };
}

export interface DocSummary {
  id: string;
  title: string;
  engine: 'latex' | 'typst';
  owner_id: string;
  deleted_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocListResponse {
  docs: DocSummary[];
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  engine: 'latex' | 'typst';
  is_published: boolean;
  yjs_doc_id: string;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateListResponse {
  templates: Template[];
}

/**
 * A `/api/v1` bearer credential, as the management UI sees it.
 *
 * Note what is absent: the token itself and its hash. The plaintext exists
 * once, in the response to the POST that created it; the hash is verification
 * input and never leaves the server.
 */
export interface ApiToken {
  id: string;
  name: string;
  scope: 'read' | 'write';
  created_by: string;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface TokenListResponse {
  tokens: ApiToken[];
}
