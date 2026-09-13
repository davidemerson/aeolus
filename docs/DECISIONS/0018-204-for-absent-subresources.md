# 0018 — 204, not 404, for a sub-resource that is legitimately absent

- **Status**: accepted
- **Date**: 2026-08-13
- **Supersedes**: nothing. Narrows the scope of
  [`0003-acl-404-vs-403.md`](0003-acl-404-vs-403.md), which is about
  hiding existence from unauthorized readers and is unchanged.

## Context

`GET /docs/:id/synctex/latest` returned 404 in three different
situations that mean three different things:

1. the doc does not exist, or the caller cannot read it — a real error;
2. the doc exists but has never compiled — a normal, temporary state;
3. the doc exists and is a **typst** document — a normal, *permanent*
   state, because typst emits no synctex data at all.

The editor fetches this endpoint on every mount, to restore PDF↔source
jumps without forcing a recompile. Case 3 is therefore not an edge case:
it is every load of every typst document, forever. Each one logged a
red `Failed to load resource: 404` in the console and a failed request
in the network panel.

That is corrosive in two specific ways, both of which we have been
bitten by before:

- A console that always has errors in it is a console nobody reads. The
  next real error arrives into a place where errors are normal.
- Any error tracker pointed at this app — or any reverse-proxy 4xx rate
  an operator graphs — counts these as failures. A 4xx rate that is
  permanently non-zero cannot be alarmed on, so it gets a threshold, and
  the threshold is where real regressions hide.

The client already treated the 404 as non-fatal — it caught and ignored
it. So the status code was carrying no information the client used,
while imposing noise on every other observer.

## Decision

For a **sub-resource of a resource the caller may read**, "there is no
such sub-resource yet, and that is normal" answers **204 No Content**.

404 is reserved for the parent being absent or invisible: unknown doc id,
or a doc the caller has no read access to (which, per ADR 0003, is
deliberately indistinguishable from absent). 403 is reserved for an
explicit forbidden read where hiding existence is not required.

Applied here:

| Situation | Before | After |
| --- | --- | --- |
| Unknown doc id | 404 | 404 |
| No read access | 404 / 403 | 404 / 403 (unchanged — ADR 0003) |
| Doc exists, never compiled | 404 | **204** |
| Doc exists, typst engine | 404 | **204** |
| Successful compile, `synctex_key IS NULL` | 404 | **204** |
| Row exists, blob is gone (GC'd, partial restore) | 404 | **204** |

The last row is deliberate. A dangling blob key is an operational
problem, but there is nothing the *caller* can do differently and the
editor's handling is identical to "none yet" — so it gets the same
status. It is not silent: it is visible in the GC/restore paths and in
the blob-GC sweep, which are where that class of problem belongs.

The ACL check still runs **before** the lookup, so 204 never leaks the
existence of a doc the caller cannot read.

## Consequences

- The web api client (`apps/web/src/lib/api.ts`) already maps an empty
  body to `undefined`, so a 204 needs no client plumbing. The caller
  must guard on `undefined` rather than assigning unconditionally —
  `useCompileLifecycle` does, so a 204 arriving after a compile has
  already installed a fresh map cannot wipe it.
- A typst document now loads with a clean console. Any 404 from this
  endpoint is once again a real finding.
- `tests/integration/compile.synctex-latest.test.ts` pins all six rows
  of the table above, including the two that must *not* become 204
  (unknown doc, no access). Collapsing these back into a single status
  is an easy and invisible regression, which is what the test exists to
  stop.

## Alternatives considered

- **200 with `{"synctex": null}`.** Works, and is arguably friendlier to
  a typed client. Rejected because it changes the success-shape of an
  endpoint that otherwise returns the map itself at the top level, so
  every consumer would need to unwrap. 204 says the same thing without
  inventing an envelope.
- **Have the client skip the fetch for typst docs.** Cheaper by one
  request, and worth doing as an optimisation later, but it does not fix
  cases 2 (never compiled) or 5 (`synctex_key IS NULL`), and it puts
  engine-specific knowledge about compiler internals into the SPA. The
  server knows whether a sync map exists; the client should not have to
  predict it.
- **Leave it and filter the noise in the error tracker.** Rejected: a
  suppression rule that broad ("ignore 404s from /synctex/latest") also
  hides case 1, which is the case we would want to hear about.
