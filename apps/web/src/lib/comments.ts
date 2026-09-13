import * as Y from 'yjs';

// Inline-comments data model — see docs/DECISIONS/0014-inline-comments.md.
// Threads are stored on a Y.Map keyed by thread id, alongside the
// `Y.Text('source')` that holds the document content. Anchors use
// Y.RelativePosition so concurrent edits don't drift the markers.

export const COMMENTS_KEY = 'comments';

export interface CommentReply {
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: number;
}

export interface ThreadView {
  id: string;
  // Resolved character offsets in the live source. `null` when the
  // anchor no longer resolves (the surrounding text was deleted).
  from: number | null;
  to: number | null;
  resolved: boolean;
  authorId: string;
  authorName: string | null;
  createdAt: number;
  // The selection text captured at creation time. Used by the
  // sidebar so stale / unresolvable threads still preview a snippet.
  preview: string;
  body: string;
  replies: CommentReply[];
}

function threadsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(COMMENTS_KEY);
}

export interface CreateThreadInput {
  // Absolute character offsets in the source (from CodeMirror's
  // selection). Caller is responsible for ordering from <= to.
  from: number;
  to: number;
  body: string;
  authorId: string;
  authorName: string | null;
  preview: string;
}

// Create a new thread. Generates a UUID, encodes the anchors as
// RelativePositions against the current source, and writes both
// metadata and the initial body in a single Yjs transaction so
// observers see a fully-formed thread.
export function createThread(doc: Y.Doc, input: CreateThreadInput): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const text = doc.getText('source');
  doc.transact(() => {
    const t = new Y.Map<unknown>();
    t.set('id', id);
    // Y.encodeRelativePosition returns a Uint8Array. Stored as-is so
    // the transport layer (y-websocket) ships bytes verbatim.
    t.set(
      'from',
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, input.from)),
    );
    t.set('to', Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, input.to)));
    t.set('resolved', false);
    t.set('authorId', input.authorId);
    t.set('authorName', input.authorName);
    t.set('createdAt', Date.now());
    t.set('preview', input.preview);
    t.set('body', input.body);
    t.set('replies', new Y.Array<Y.Map<unknown>>());
    threadsMap(doc).set(id, t);
  });
  return id;
}

export function addReply(
  doc: Y.Doc,
  threadId: string,
  reply: { text: string; authorId: string; authorName: string | null },
): boolean {
  const t = threadsMap(doc).get(threadId);
  if (!t) return false;
  const replies = t.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
  if (!replies) return false;
  doc.transact(() => {
    const r = new Y.Map<unknown>();
    r.set('authorId', reply.authorId);
    r.set('authorName', reply.authorName);
    r.set('text', reply.text);
    r.set('createdAt', Date.now());
    replies.push([r]);
  });
  return true;
}

export function setResolved(doc: Y.Doc, threadId: string, resolved: boolean): boolean {
  const t = threadsMap(doc).get(threadId);
  if (!t) return false;
  doc.transact(() => {
    t.set('resolved', resolved);
  });
  return true;
}

export function deleteThread(doc: Y.Doc, threadId: string): boolean {
  const map = threadsMap(doc);
  if (!map.has(threadId)) return false;
  doc.transact(() => {
    map.delete(threadId);
  });
  return true;
}

// Resolve every thread to a ThreadView the editor / panel can
// render. Anchors are resolved against the live source; threads
// whose anchors don't resolve still appear with from/to=null so
// the panel can show them with a "stale anchor" indicator.
export function listThreads(doc: Y.Doc): ThreadView[] {
  const text = doc.getText('source');
  const out: ThreadView[] = [];
  for (const [id, t] of threadsMap(doc).entries()) {
    const fromBytes = t.get('from') as Uint8Array | undefined;
    const toBytes = t.get('to') as Uint8Array | undefined;
    let from: number | null = null;
    let to: number | null = null;
    if (fromBytes && toBytes) {
      try {
        const fromAbs = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(fromBytes),
          doc,
        );
        const toAbs = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(toBytes),
          doc,
        );
        if (fromAbs && fromAbs.type === text) from = fromAbs.index;
        if (toAbs && toAbs.type === text) to = toAbs.index;
      } catch {
        // Malformed anchor bytes — fall through with null offsets.
      }
    }

    const repliesArray = t.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
    const replies: CommentReply[] = [];
    if (repliesArray) {
      for (let i = 0; i < repliesArray.length; i += 1) {
        const r = repliesArray.get(i);
        replies.push({
          authorId: String(r.get('authorId') ?? ''),
          authorName: (r.get('authorName') as string | null | undefined) ?? null,
          text: String(r.get('text') ?? ''),
          createdAt: Number(r.get('createdAt') ?? 0),
        });
      }
    }

    out.push({
      id,
      from,
      to,
      resolved: Boolean(t.get('resolved')),
      authorId: String(t.get('authorId') ?? ''),
      authorName: (t.get('authorName') as string | null | undefined) ?? null,
      createdAt: Number(t.get('createdAt') ?? 0),
      preview: String(t.get('preview') ?? ''),
      body: String(t.get('body') ?? ''),
      replies,
    });
  }
  // Newest threads first; resolved threads sink to the bottom.
  out.sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return b.createdAt - a.createdAt;
  });
  return out;
}

// Subscribe to any change in the threads map (top-level adds,
// deletes, or any nested mutation — body edits, replies, resolved
// flips). The callback receives the freshly-resolved ThreadView[].
export function onThreadsChange(doc: Y.Doc, callback: (threads: ThreadView[]) => void): () => void {
  const observer = (): void => callback(listThreads(doc));
  threadsMap(doc).observeDeep(observer);
  // Push the initial state so consumers don't have to re-derive.
  callback(listThreads(doc));
  return () => threadsMap(doc).unobserveDeep(observer);
}
