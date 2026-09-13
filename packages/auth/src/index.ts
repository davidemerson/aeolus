export {
  PASSPHRASE_LONG_ENOUGH,
  PASSPHRASE_MAX_LENGTH,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_MIN_WORDS,
  PASSPHRASE_RULE,
  checkPassphrase,
  generatePassphrase,
  hashPassphrase,
  needsRehash,
  verifyPassphrase,
} from './passphrase.js';
export type { PassphraseCheck, PassphraseContext } from './passphrase.js';

export {
  createSessionStore,
  purgeExpiredSessions,
  sessionConstants,
  sessionCookieOptions,
} from './session.js';
export type { SessionStore, SessionRecord, CookieOptions } from './session.js';

export {
  DocArchivedError,
  DocForbiddenError,
  DocNotFoundError,
  assertCanAdminister,
  assertCanRead,
  assertCanWrite,
  createDbAclDeps,
  resolveRole,
} from './acl.js';
export type { AclDeps, AclDocRow, AclUserRow, DocRole, ResolvedRole } from './acl.js';
