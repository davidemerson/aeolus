import { describe, expect, it } from 'vitest';

import {
  DEV_DATABASE_URL,
  MissingEnvError,
  envFlag,
  envFlagOrUndefined,
  requireEnv,
} from './env.js';
import { poolSslFor } from './index.js';

const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('requireEnv', () => {
  it('returns the value when set', () => {
    expect(
      requireEnv('DATABASE_URL', DEV_DATABASE_URL, { ...prod, DATABASE_URL: 'postgres://x' }),
    ).toBe('postgres://x');
  });

  it('falls back to the dev default outside production', () => {
    expect(requireEnv('DATABASE_URL', DEV_DATABASE_URL, dev)).toBe(DEV_DATABASE_URL);
  });

  it('throws in production when unset, naming the variable', () => {
    expect(() => requireEnv('AEOLUS_COOKIE_SECRET', 'dev-secret', prod)).toThrow(MissingEnvError);
    expect(() => requireEnv('AEOLUS_COOKIE_SECRET', 'dev-secret', prod)).toThrow(
      /AEOLUS_COOKIE_SECRET/,
    );
  });

  it('throws everywhere when there is no dev default', () => {
    expect(() => requireEnv('AEOLUS_S3_BUCKET', undefined, dev)).toThrow(MissingEnvError);
  });

  it('treats an empty string as unset', () => {
    expect(() => requireEnv('DATABASE_URL', undefined, { ...prod, DATABASE_URL: '' })).toThrow(
      MissingEnvError,
    );
  });
});

describe('envFlag / envFlagOrUndefined', () => {
  it('envFlag is true only for the literal 1', () => {
    expect(envFlag('X', { X: '1' })).toBe(true);
    expect(envFlag('X', { X: 'true' })).toBe(false);
    expect(envFlag('X', {})).toBe(false);
  });

  it('envFlagOrUndefined leaves an unset flag undefined so a ?? default applies', () => {
    // The api launcher passed `AEOLUS_LOG === '1'` (always a boolean), which
    // defeated buildServer's `deps.logger ?? NODE_ENV === 'production'`
    // and kept production error logging off.
    expect(envFlagOrUndefined('AEOLUS_LOG', {})).toBeUndefined();
    expect(envFlagOrUndefined('AEOLUS_LOG', { AEOLUS_LOG: '1' })).toBe(true);
    expect(envFlagOrUndefined('AEOLUS_LOG', { AEOLUS_LOG: '0' })).toBe(false);
  });
});

describe('poolSslFor — AEOLUS_DB_SSL decides', () => {
  it('disable means no TLS, even for a remote host', () => {
    expect(poolSslFor('postgres://u:p@db.example.internal/d', { mode: 'disable' })).toBe(false);
  });

  it('require means TLS without checking who answered', () => {
    expect(poolSslFor('postgres://u:p@db.example.internal/d', { mode: 'require' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verify uses the CA bundle', () => {
    expect(
      poolSslFor('postgres://u:p@db.example.internal/d', { mode: 'verify', ca: 'PEM' }),
    ).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
  });

  it('verify without a bundle is a boot failure, not a silent downgrade', () => {
    expect(() =>
      poolSslFor('postgres://u:p@db.example.internal/d', { mode: 'verify', ca: null }),
    ).toThrow(/AEOLUS_DB_CA_FILE/);
  });

  it('refuses a value it does not understand rather than picking one', () => {
    expect(() => poolSslFor('postgres://u:p@localhost/d', { mode: 'yes please' })).toThrow(
      /AEOLUS_DB_SSL/,
    );
  });
});

describe('poolSslFor — the fallback when AEOLUS_DB_SSL is unset', () => {
  it('disables TLS for loopback and the compose hostnames', () => {
    expect(poolSslFor('postgres://u:p@localhost:5432/d')).toBe(false);
    expect(poolSslFor('postgres://u:p@127.0.0.1:5432/d')).toBe(false);
    expect(poolSslFor('postgres://u:p@postgres:5432/d')).toBe(false);
    expect(poolSslFor('postgres://u:p@db:5432/d')).toBe(false);
  });

  it('verifies against the bundle when one is present', () => {
    expect(poolSslFor('postgres://u:p@db.example.internal/d', { ca: 'PEM' })).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
    });
  });

  it('refuses to guess in production', () => {
    expect(() =>
      poolSslFor('postgres://u:p@db.example.internal/d', { ca: null, production: true }),
    ).toThrow(/AEOLUS_DB_SSL/);
  });

  it('warns and proceeds unverified outside production, without the password', () => {
    const lines: string[] = [];
    const ssl = poolSslFor('postgres://aeolus:s3cret@db.example.internal/d', {
      ca: null,
      production: false,
      warn: (line) => lines.push(line),
    });
    expect(ssl).toEqual({ rejectUnauthorized: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WITHOUT certificate verification');
    expect(lines[0]).not.toContain('s3cret');
  });
});
