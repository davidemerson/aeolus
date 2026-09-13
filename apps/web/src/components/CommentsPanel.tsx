import { useCallback, useEffect, useState } from 'react';

import { Button, ConfirmInline, toastStore } from '@aeolus/shared/ui';

import {
  addReply,
  deleteThread,
  onThreadsChange,
  setResolved,
  type ThreadView,
} from '../lib/comments.js';
import { formatDateTime } from '../lib/format.js';
import * as Y from 'yjs';

interface CommentsPanelProps {
  ydoc: Y.Doc | null;
  // Current user identity for reply attribution. Falls back to
  // anonymous strings when the session is mid-load.
  userId: string;
  userName: string | null;
  // Reading-only when the session lacks write access (viewer role,
  // ws auth failed, etc.). Disables reply / resolve / delete.
  canWrite: boolean;
  // Click on a thread → editor jumps to its anchored range.
  onJump: (from: number, to: number) => void;
  // Toggled by the host so the panel header can show "showing
  // resolved" state. Resolved threads sink to the bottom regardless.
  showResolved: boolean;
  setShowResolved: (next: boolean) => void;
  // Inline composer for a new thread. The host sets this after
  // capturing the editor selection ("+ comment"); the panel renders a
  // small form at the top and hands the body back. Replaces
  // window.prompt, which browsers block when the app is framed inside
  // the portal.
  composer?: { preview: string } | null;
  onComposerSubmit?: (body: string) => void;
  onComposerCancel?: () => void;
}

export function CommentsPanel({
  ydoc,
  userId,
  userName,
  canWrite,
  onJump,
  showResolved,
  setShowResolved,
  composer = null,
  onComposerSubmit,
  onComposerCancel,
}: CommentsPanelProps): JSX.Element {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [openReply, setOpenReply] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  // Thread whose delete is awaiting the inline confirm. Replaces the native
  // confirm(), which browsers block when the app is framed in the portal.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // A fresh composer (new selection) starts empty.
  useEffect(() => {
    setComposerDraft('');
  }, [composer]);

  const submitComposer = useCallback(() => {
    const body = composerDraft.trim();
    if (!body) return;
    onComposerSubmit?.(body);
    setComposerDraft('');
  }, [composerDraft, onComposerSubmit]);

  useEffect(() => {
    if (!ydoc) {
      setThreads([]);
      return;
    }
    const stop = onThreadsChange(ydoc, setThreads);
    return stop;
  }, [ydoc]);

  const submitReply = useCallback(
    (threadId: string) => {
      if (!ydoc) return;
      const text = (replyDraft[threadId] ?? '').trim();
      if (!text) return;
      const ok = addReply(ydoc, threadId, {
        text,
        authorId: userId,
        authorName: userName,
      });
      if (!ok) {
        toastStore.push({ kind: 'error', message: 'Reply failed — thread missing' });
        return;
      }
      setReplyDraft((d) => ({ ...d, [threadId]: '' }));
      setOpenReply(null);
    },
    [ydoc, replyDraft, userId, userName],
  );

  const visible = threads.filter((t) => showResolved || !t.resolved);
  const openCount = threads.filter((t) => !t.resolved).length;
  const resolvedCount = threads.length - openCount;

  return (
    <div
      className="flex h-full flex-col border-r border-hairline-strong bg-surface"
      data-testid="comments-panel"
    >
      <div className="flex items-center justify-between border-b border-hairline-strong px-3 py-2">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-body-2">
            Comments
          </span>
          <span className="ml-2 text-[11px] text-muted">
            {openCount} open
            {resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ''}
          </span>
        </div>
        {resolvedCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowResolved(!showResolved)}
            data-testid="comments-toggle-resolved"
          >
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </Button>
        ) : null}
      </div>
      {composer ? (
        <div
          className="border-b border-hairline-strong bg-page px-3 py-2"
          data-testid="comment-composer"
        >
          <div
            className="mb-1 truncate font-mono text-[11px] text-accent-text"
            title={composer.preview}
          >
            {composer.preview || '(empty selection)'}
          </div>
          <textarea
            autoFocus
            rows={2}
            value={composerDraft}
            onChange={(e) => setComposerDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitComposer();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onComposerCancel?.();
              }
            }}
            placeholder="Write a comment…"
            aria-label="New comment"
            className="w-full resize-none rounded border border-hairline-strong bg-surface px-2 py-1 text-xs text-body focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
            data-testid="comment-composer-input"
          />
          <div className="mt-1 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onComposerCancel?.()}
              data-testid="comment-composer-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!composerDraft.trim()}
              onClick={submitComposer}
              data-testid="comment-composer-submit"
            >
              Add comment
            </Button>
          </div>
        </div>
      ) : null}
      {ydoc === null ? (
        // The thread list comes from the Y.Doc; until the connection hands
        // one over there is nothing to count, so say so rather than "no
        // comments" — a document full of them looks identical for a beat.
        <div className="p-4 text-xs text-muted" data-testid="comments-loading">
          Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="p-4 text-xs text-muted">
          {threads.length === 0
            ? 'No comments yet. Highlight text in the editor and press the Comment button to start a thread.'
            : 'No open comments.'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visible.map((t) => (
            <div
              key={t.id}
              data-testid={`comment-thread-${t.id}`}
              data-resolved={t.resolved || undefined}
              className={`border-b border-hairline px-3 py-2 text-xs ${
                t.resolved ? 'bg-page opacity-70' : ''
              }`}
            >
              <button
                type="button"
                disabled={t.from === null || t.to === null}
                onClick={() => {
                  if (t.from !== null && t.to !== null) onJump(t.from, t.to);
                }}
                className="block w-full text-left"
                data-testid={`comment-jump-${t.id}`}
              >
                <div className="mb-1 truncate font-mono text-[11px] text-accent-text">
                  {t.preview || '(empty selection)'}
                </div>
                <div className="text-body-2">{t.body}</div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                  <span>{t.authorName ?? t.authorId.slice(0, 6)}</span>
                  <span>·</span>
                  <span>{formatDateTime(t.createdAt)}</span>
                  {t.from === null ? (
                    <span
                      className="ml-auto rounded-badge bg-warning-bg px-1.5 py-0.5 text-warning-fg-strong"
                      title="The text this comment was attached to has changed, so it no longer points at a place in the document."
                    >
                      Text moved
                    </span>
                  ) : null}
                </div>
              </button>
              {t.replies.length > 0 ? (
                <div className="mt-2 space-y-1 border-l-2 border-hairline-strong pl-2">
                  {t.replies.map((r, i) => (
                    <div key={i}>
                      <div className="text-body-2">{r.text}</div>
                      <div className="text-[10px] text-muted">
                        {r.authorName ?? r.authorId.slice(0, 6)} · {formatDateTime(r.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {canWrite && !t.resolved && confirmDeleteId === t.id ? (
                <ConfirmInline
                  className="mt-2"
                  message="Delete this thread? This cannot be undone."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => {
                    if (ydoc) deleteThread(ydoc, t.id);
                    setConfirmDeleteId(null);
                  }}
                  onCancel={() => setConfirmDeleteId(null)}
                  testId={`comment-delete-${t.id}`}
                />
              ) : canWrite && !t.resolved ? (
                <div className="mt-2 flex items-center gap-2">
                  {openReply === t.id ? (
                    <>
                      <input
                        type="text"
                        autoFocus
                        value={replyDraft[t.id] ?? ''}
                        onChange={(e) => setReplyDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitReply(t.id);
                          else if (e.key === 'Escape') setOpenReply(null);
                        }}
                        placeholder="Reply…"
                        aria-label="Reply"
                        className="flex-1 rounded border border-hairline-strong px-2 py-1 text-xs focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                        data-testid={`comment-reply-input-${t.id}`}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => submitReply(t.id)}
                        data-testid={`comment-reply-submit-${t.id}`}
                      >
                        Reply
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenReply(t.id)}
                      data-testid={`comment-reply-open-${t.id}`}
                    >
                      Reply
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!ydoc) return;
                      setResolved(ydoc, t.id, true);
                    }}
                    data-testid={`comment-resolve-${t.id}`}
                  >
                    Resolve
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDeleteId(t.id)}
                    data-testid={`comment-delete-${t.id}`}
                  >
                    Delete
                  </Button>
                </div>
              ) : canWrite && t.resolved ? (
                <div className="mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!ydoc) return;
                      setResolved(ydoc, t.id, false);
                    }}
                    data-testid={`comment-reopen-${t.id}`}
                  >
                    Reopen
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
