// Process-environment helpers for the three launchers (apps/{api,ws,
// compile-worker}/src/bin). They live here rather than in @aeolus/shared
// because every server process already depends on @aeolus/db, and
// @aeolus/shared carries a React peer dependency the server images
// should not pick up.
//
// The rule they encode (ADR 0024): a variable the process cannot run
// without is a boot failure in production. Before 2026-09-13 both api
// and ws fell back to a localhost DATABASE_URL and to the literal cookie
// secret 'dev-cookie-secret-change-me' when the deployed task was missing
// the value — a *working* server signing cookies with a public constant.

export const DEV_DATABASE_URL = 'postgres://aeolus:aeolus@127.0.0.1:5432/aeolus';
export const DEV_COOKIE_SECRET = 'dev-cookie-secret-change-me';

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export class MissingEnvError extends Error {
  override readonly name = 'MissingEnvError';

  constructor(readonly variable: string) {
    super(
      `${variable} is not set. It is required in production; ` +
        `see the process's env table in README.md § Configuration.`,
    );
  }
}

/**
 * Read a variable the process cannot run without. In production (NODE_ENV
 * =production, which every Dockerfile sets) a missing value throws
 * MissingEnvError so the task fails at boot instead of running against a
 * default. Outside production `devDefault` fills in, so a laptop boot
 * needs no .env file.
 */
export function requireEnv(
  name: string,
  devDefault?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (value) return value;
  if (devDefault !== undefined && !isProduction(env)) return devDefault;
  throw new MissingEnvError(name);
}

/** `NAME=1` → true; anything else, including unset → false. */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === '1';
}

/**
 * Like envFlag, but `undefined` when the variable is unset — so a `??`
 * default further down the stack still applies. `AEOLUS_LOG === '1'` at the
 * api launcher always produced a boolean, which defeated buildServer's
 * `deps.logger ?? NODE_ENV === 'production'` and kept production error
 * logging off (found 2026-09-13).
 */
export function envFlagOrUndefined(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const value = env[name];
  return value === undefined ? undefined : value === '1';
}
