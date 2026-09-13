# 0014 — Inline comments: Yjs-native storage, no new tables

- **Status**: accepted
- **Date**: 2026-05-01
- **Deciders**: davidemerson

## Context

`docs/ARCHITECTURE.md` deferred inline comments out of v1, but
parity with Overleaf's collaboration story is the strongest
argument for promoting them. Comments are a hard collaboration
feature to retrofit because they need anchors that survive edits
to the source — a thread tied to "characters 14–22" goes wrong the
moment another collaborator inserts text at offset 5.

Three viable shapes for the data model:

### Option A — Yjs-native (chosen)

Store the threads inside the Y.Doc that already holds the source.
A `Y.Map<threadId, threadData>` lives next to `Y.Text('source')`,
where each `threadData` is itself a `Y.Map` carrying:

- `from` — encoded `Y.RelativePosition` (Uint8Array) for the
  selection start.
- `to` — encoded `Y.RelativePosition` for the end.
- `resolved` — boolean flag.
- `authorId`, `createdAt` — provenance.
- `replies` — `Y.Array` of `{ authorId, text, createdAt }` maps.

Anchors are resolved against the live document via
`Y.createAbsolutePositionFromRelativePosition` whenever the
editor needs to render a decoration or jump to a thread.

**Pros**

- Anchors automatically follow concurrent edits — that's the
  defining property of `RelativePosition`, no app-level glue
  needed.
- Sync uses the same y-websocket transport already in production
  (`apps/ws`); two browsers see each other's threads, replies, and
  resolutions without any new pub/sub.
- Zero schema work. No migration, no API surface, no extra
  authorization branch — `assertCanRead` already gates the Yjs
  channel that holds the threads.

**Cons**

- Threads ride along with the content blob, so any code that
  encodes the Y.Doc (download zip text rendering, checkpoints) has
  to be aware of the side-channel if it wants to strip them. v1
  doesn't strip; the project zip emits source-only and ignores the
  threads map, so threads stay in the live editor only.
- No "viewer can comment but not edit" tier. Today an editor can
  comment; a viewer cannot mutate the Yjs doc at all. We accept
  that until reviewer-mode is a real product requirement.

### Option B — DB-native table

`doc_comments(id, doc_id, anchor_from, anchor_to, body, …)` with
the anchors stored as encoded RelativePosition bytes.

**Why not.** Adds two new tables, an API surface, and a fan-out
mechanism (LISTEN/NOTIFY?) for live updates — and we'd still need
the encoded RelativePosition to do anything useful with the
anchor. The combined complexity is higher than Option A, and the
"separable from content" benefit only pays off for a feature nobody
has asked for (querying threads outside the editor).

### Option C — Hybrid

Anchors in Yjs, bodies in DB. Buys a bit of database queryability
at the cost of two writes per action and ordering surprises
(which writer commits first when both sides are racing to add a
reply?). Not worth it for a document with a handful of collaborators
in it.

## Decision

Option A. Threads live in the Y.Doc as a `Y.Map('comments')`
sibling of the existing `Y.Text('source')`. The editor binds a
`y-codemirror.next` `yCollab` extension to the source as today,
and a separate observer subscribes to the threads map to drive
both a CodeMirror decoration set (margin markers + underline) and
a sidebar `CommentsPanel`.

The wire format is fixed-shape so the parser can be defensive:

```ts
type ThreadId = string;          // crypto.randomUUID()
interface ThreadView {
  id: ThreadId;
  from: Y.RelativePosition;      // resolved → number
  to: Y.RelativePosition;        // resolved → number
  resolved: boolean;
  authorId: string;
  authorName: string | null;
  createdAt: number;             // Date.now()
  body: string;                  // first message, inline
  replies: Array<{
    authorId: string;
    authorName: string | null;
    text: string;
    createdAt: number;
  }>;
}
```

Anchor resolution happens lazily: the panel renders the thread
list with the original selection text (cached on the thread at
creation time) so a stale or unresolvable anchor still shows its
preview. Decorations skip threads whose anchors no longer
resolve.

## Authorization & policy

- **Read.** Same as the source — any role with `assertCanRead`
  access is on the Yjs channel and sees the threads map.
- **Write.** Same as `assertCanWrite` — the WebSocket upgrade
  rejects viewer mutations, which means viewers can read threads
  but cannot create or reply. This matches how the rest of the
  product enforces ACL.
- **Admin override.** Inherits from `resolveRole`; admins are
  always treated as `owner` and can act on any thread.

## What ships now (v1)

1. `apps/web/src/lib/comments.ts` — thread CRUD helpers operating
   on a `Y.Doc`.
2. `apps/web/src/components/CommentsPanel.tsx` — sidebar tab
   showing open threads with reply / resolve buttons.
3. CodeMirror decoration in the editor for anchored ranges.
4. Selection toolbar entry (or top-bar button) that creates a
   thread from the current selection.
5. Unit tests covering anchor preservation through concurrent
   edits (two Y.Docs sync via `Y.applyUpdate`, threads converge,
   anchors track moved text).

## What is explicitly out of scope

- Mentions / notifications.
- PDF margin annotations.
- Comment-only "reviewer" role.
- Per-thread email digests.
- Cross-file thread navigation in the sidebar (each open file's
  Y.Doc has its own threads map; the panel scopes to the
  currently-loaded file).

These are all additive — none of them require revisiting the
storage decision above.
