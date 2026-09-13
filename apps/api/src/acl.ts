export {
  DocArchivedError,
  DocForbiddenError,
  DocNotFoundError,
  assertCanAdminister,
  assertCanRead,
  assertCanWrite,
  createDbAclDeps,
  resolveRole,
} from '@aeolus/auth';
export type { AclDeps, AclDocRow, AclUserRow, DocRole, ResolvedRole } from '@aeolus/auth';
