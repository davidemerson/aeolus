/*
 * aeolus-sandbox — confine a child process to an explicit set of filesystem paths
 * using Landlock, then exec it.
 *
 * Why this exists: the compile worker runs Tectonic/Typst against
 * attacker-controlled document source. Tectonic has no path sandbox, so
 * `\input{/etc/passwd}` (or /proc/<pid>/environ, holding the worker's secrets)
 * reads any file the `compiler` user can reach and renders it into the PDF.
 * Landlock rules are inherited across execve, so applying a ruleset here and
 * then exec'ing the engine confines the engine and everything it spawns.
 *
 * See docs/DECISIONS/0022-sandbox-compile-engine-with-landlock.md.
 *
 * Usage:
 *   aeolus-sandbox [--ro PATH]... [--rw PATH]... --mode audit|enforce -- CMD [ARG]...
 *   aeolus-sandbox --probe
 *
 * Modes:
 *   enforce  Apply the ruleset. If Landlock is unavailable, exit non-zero
 *            WITHOUT exec — fail closed, never run the engine unconfined.
 *   audit    Attempt to apply; print the verdict to stderr; exec regardless.
 *            (Rollout phase 1: learn whether this kernel enforces, without
 *            risking a compile outage.)
 *   --probe  Report the Landlock verdict and exit. The worker's boot self-test.
 *
 * Exit codes: 64 usage, 71 OS/enforce-unavailable (EX_OSERR), 126 exec failed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

/* Every filesystem access right through ABI v3. We negotiate the ABI at
 * runtime and mask off anything the running kernel does not know, so the same
 * binary works on an old kernel (fewer rights) and a new one. */
#define ACCESS_FS_ALL ( \
    LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | \
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | \
    LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | \
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | \
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | \
    LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | \
    LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | \
    LANDLOCK_ACCESS_FS_TRUNCATE)

/* Read-only path: read files, list dirs, execute. */
#define ACCESS_RO ( \
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | \
    LANDLOCK_ACCESS_FS_EXECUTE)

/* When an allow path is a regular file, not a directory, Landlock rejects a
 * rule carrying directory-only rights (READ_DIR, MAKE_*). Mask to this. */
#define ACCESS_FILE_ONLY ( \
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | \
    LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE)

/* Read-write path: RO plus create/remove/write/truncate under it. */
#define ACCESS_RW (ACCESS_RO | \
    LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE | \
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_DIR | \
    LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_MAKE_FIFO | \
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_REMOVE_FILE | \
    LANDLOCK_ACCESS_FS_REMOVE_DIR)

static int ll_create_ruleset(const struct landlock_ruleset_attr *attr,
                             size_t size, uint32_t flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static int ll_add_rule(int fd, enum landlock_rule_type type, const void *attr,
                       uint32_t flags) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}
static int ll_restrict_self(int fd, uint32_t flags) {
  return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

/* Returns the supported ABI version (>=1), or -1 with *reason set. */
static int landlock_abi(const char **reason) {
  int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    if (errno == ENOSYS)
      *reason = "landlock syscall not present (kernel < 5.13)";
    else if (errno == EOPNOTSUPP)
      *reason = "landlock disabled at boot (not in CONFIG_LSM)";
    else if (errno == EPERM)
      *reason = "landlock syscall blocked (seccomp filter)";
    else
      *reason = strerror(errno);
    return -1;
  }
  return abi;
}

struct pathrule {
  const char *path;
  uint64_t access;
};

/* Apply the ruleset. Returns 0 on success, -1 on failure (*reason set). */
static int apply(struct pathrule *rules, int n, const char **reason) {
  const char *r;
  int abi = landlock_abi(&r);
  if (abi < 0) {
    *reason = r;
    return -1;
  }

  uint64_t handled = ACCESS_FS_ALL;
  /* Mask off rights this kernel's ABI does not know. */
  if (abi < 2) handled &= ~LANDLOCK_ACCESS_FS_REFER;
  if (abi < 3) handled &= ~LANDLOCK_ACCESS_FS_TRUNCATE;

  struct landlock_ruleset_attr attr = {.handled_access_fs = handled};
  int rs = ll_create_ruleset(&attr, sizeof(attr), 0);
  if (rs < 0) {
    *reason = strerror(errno);
    return -1;
  }

  for (int i = 0; i < n; i++) {
    int pfd = open(rules[i].path, O_PATH | O_CLOEXEC);
    if (pfd < 0) {
      /* A path we were told to allow does not exist. In enforce mode this is
       * a misconfiguration — refuse rather than silently widen. */
      fprintf(stderr, "aeolus-sandbox: cannot open allow path %s: %s\n",
              rules[i].path, strerror(errno));
      close(rs);
      *reason = "allow path missing";
      return -1;
    }
    uint64_t access = rules[i].access & handled;
    struct stat st;
    if (fstat(pfd, &st) == 0 && !S_ISDIR(st.st_mode))
      access &= ACCESS_FILE_ONLY; /* a file cannot carry dir rights */
    struct landlock_path_beneath_attr pb = {
        .allowed_access = access,
        .parent_fd = pfd,
    };
    if (ll_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &pb, 0) < 0) {
      fprintf(stderr, "aeolus-sandbox: add_rule %s: %s\n", rules[i].path,
              strerror(errno));
      close(pfd);
      close(rs);
      *reason = "add_rule failed";
      return -1;
    }
    close(pfd);
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
    *reason = "prctl(NO_NEW_PRIVS) failed";
    close(rs);
    return -1;
  }
  if (ll_restrict_self(rs, 0)) {
    *reason = strerror(errno);
    close(rs);
    return -1;
  }
  close(rs);
  return 0;
}

static void usage(void) {
  fprintf(stderr,
          "usage: aeolus-sandbox [--ro PATH]... [--rw PATH]... "
          "--mode audit|enforce -- CMD [ARG]...\n"
          "       aeolus-sandbox --probe\n");
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    const char *reason;
    int abi = landlock_abi(&reason);
    if (abi < 0) {
      printf("aeolus-sandbox: landlock UNAVAILABLE (%s)\n", reason);
      return 0; /* a probe always exits 0; the line is the signal */
    }
    printf("aeolus-sandbox: landlock enforcing (ABI v%d)\n", abi);
    return 0;
  }

  struct pathrule rules[256];
  int nrules = 0;
  const char *mode = NULL;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    } else if (strcmp(argv[i], "--ro") == 0 && i + 1 < argc) {
      if (nrules >= 256) { fprintf(stderr, "aeolus-sandbox: too many paths\n"); return 64; }
      rules[nrules].path = argv[++i];
      rules[nrules].access = ACCESS_RO;
      nrules++;
    } else if (strcmp(argv[i], "--rw") == 0 && i + 1 < argc) {
      if (nrules >= 256) { fprintf(stderr, "aeolus-sandbox: too many paths\n"); return 64; }
      rules[nrules].path = argv[++i];
      rules[nrules].access = ACCESS_RW;
      nrules++;
    } else if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
      mode = argv[++i];
    } else {
      fprintf(stderr, "aeolus-sandbox: unknown arg: %s\n", argv[i]);
      usage();
      return 64;
    }
  }

  if (!mode || (strcmp(mode, "audit") != 0 && strcmp(mode, "enforce") != 0)) {
    fprintf(stderr, "aeolus-sandbox: --mode audit|enforce is required\n");
    usage();
    return 64;
  }
  if (i >= argc) {
    fprintf(stderr, "aeolus-sandbox: no command after --\n");
    usage();
    return 64;
  }

  const char *reason = NULL;
  int rc = apply(rules, nrules, &reason);
  int enforce = strcmp(mode, "enforce") == 0;

  if (rc < 0) {
    if (enforce) {
      fprintf(stderr,
              "aeolus-sandbox: landlock UNAVAILABLE (%s); refusing to run "
              "unconfined in enforce mode\n",
              reason);
      return 71; /* fail closed */
    }
    fprintf(stderr, "aeolus-sandbox: landlock UNAVAILABLE (%s); running "
                    "UNCONFINED (audit mode)\n",
            reason);
  } else {
    fprintf(stderr, "aeolus-sandbox: landlock enforcing\n");
  }

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "aeolus-sandbox: exec %s: %s\n", argv[i], strerror(errno));
  return 126;
}
