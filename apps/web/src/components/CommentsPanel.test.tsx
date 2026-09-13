import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

import { CommentsPanel } from './CommentsPanel.js';
import { addReply, COMMENTS_KEY, createThread, setResolved } from '../lib/comments.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeDocWithThreads(): { doc: Y.Doc; ids: string[] } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, 'The quick brown fox jumps over the lazy dog.');
  const a = createThread(doc, {
    from: 0,
    to: 9,
    body: 'tighten this',
    authorId: 'u1',
    authorName: 'Ada',
    preview: 'The quick',
  });
  const b = createThread(doc, {
    from: 16,
    to: 19,
    body: 'reword',
    authorId: 'u2',
    authorName: 'Bo',
    preview: 'fox',
  });
  return { doc, ids: [a, b] };
}

describe('CommentsPanel', () => {
  it('renders open threads with author and preview', () => {
    const { doc, ids } = makeDocWithThreads();
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    expect(screen.getByTestId(`comment-thread-${ids[0]}`)).toBeTruthy();
    expect(screen.getByTestId(`comment-thread-${ids[1]}`)).toBeTruthy();
    expect(screen.getByText('tighten this')).toBeTruthy();
    expect(screen.getByText('reword')).toBeTruthy();
  });

  it('clicking a thread invokes onJump with its anchored range', () => {
    const { doc, ids } = makeDocWithThreads();
    const onJump = vi.fn();
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={onJump}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId(`comment-jump-${ids[0]}`));
    expect(onJump).toHaveBeenCalledWith(0, 9);
  });

  it('hides resolved threads by default and shows them when toggled', async () => {
    const { doc, ids } = makeDocWithThreads();
    setResolved(doc, ids[0], true);
    let showResolved = false;
    const setShow = (next: boolean): void => {
      showResolved = next;
    };
    const { rerender } = render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={showResolved}
        setShowResolved={setShow}
      />,
    );
    expect(screen.queryByTestId(`comment-thread-${ids[0]}`)).toBeNull();
    expect(screen.getByTestId(`comment-thread-${ids[1]}`)).toBeTruthy();
    // Toggle.
    fireEvent.click(screen.getByTestId('comments-toggle-resolved'));
    rerender(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={showResolved}
        setShowResolved={setShow}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`comment-thread-${ids[0]}`)).toBeTruthy();
    });
  });

  it('reply input adds a reply via the helper', async () => {
    const { doc, ids } = makeDocWithThreads();
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId(`comment-reply-open-${ids[0]}`));
    const input = await waitFor(() => screen.getByTestId(`comment-reply-input-${ids[0]}`));
    fireEvent.change(input, { target: { value: 'good idea' } });
    fireEvent.click(screen.getByTestId(`comment-reply-submit-${ids[0]}`));
    await waitFor(() => {
      expect(screen.getByText('good idea')).toBeTruthy();
    });
  });

  it('updates live when threads are added externally', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'Hello, world!');
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    expect(screen.queryByText('new note')).toBeNull();
    act(() => {
      createThread(doc, {
        from: 0,
        to: 5,
        body: 'new note',
        authorId: 'remote',
        authorName: 'Remote',
        preview: 'Hello',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('new note')).toBeTruthy();
    });
  });

  it('reply path is hidden when canWrite is false', () => {
    const { doc, ids } = makeDocWithThreads();
    addReply(doc, ids[0], { text: 'an existing reply', authorId: 'u3', authorName: 'C' });
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={false}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    expect(screen.getByText('an existing reply')).toBeTruthy();
    expect(screen.queryByTestId(`comment-reply-open-${ids[0]}`)).toBeNull();
    expect(screen.queryByTestId(`comment-resolve-${ids[0]}`)).toBeNull();
  });
});

describe('CommentsPanel — loading and delete', () => {
  it('says Loading… while there is no Y.Doc yet, not "no comments"', () => {
    render(
      <CommentsPanel
        ydoc={null}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    expect(screen.getByTestId('comments-loading').textContent).toBe('Loading…');
    expect(screen.queryByText(/No comments yet/)).toBeNull();
  });

  it('delete asks to confirm inline and removes the thread only after confirm', async () => {
    const { doc, ids } = makeDocWithThreads();
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId(`comment-delete-${ids[0]}`));
    // Nothing deleted yet; the confirm has replaced the action row.
    expect(screen.getByTestId(`comment-thread-${ids[0]}`)).toBeTruthy();
    expect(screen.getByText('Delete this thread? This cannot be undone.')).toBeTruthy();

    // Cancel restores the row.
    fireEvent.click(screen.getByTestId(`comment-delete-${ids[0]}-cancel`));
    expect(screen.queryByText('Delete this thread? This cannot be undone.')).toBeNull();
    expect(screen.getByTestId(`comment-thread-${ids[0]}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`comment-delete-${ids[0]}`));
    fireEvent.click(screen.getByTestId(`comment-delete-${ids[0]}-confirm`));
    await waitFor(() => {
      expect(screen.queryByTestId(`comment-thread-${ids[0]}`)).toBeNull();
    });
    expect(screen.getByTestId(`comment-thread-${ids[1]}`)).toBeTruthy();
  });

  it('labels a comment whose text has moved and explains it in the tooltip', async () => {
    const { doc, ids } = makeDocWithThreads();
    // A relative position survives edits (it clamps), so the panel only sees
    // a null anchor when the stored bytes no longer decode — the shape an
    // older or corrupted thread arrives in. Corrupt the first thread's.
    const thread = doc.getMap<Y.Map<unknown>>(COMMENTS_KEY).get(ids[0]);
    thread?.set('from', new Uint8Array([255, 255, 255]));
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    const badge = await waitFor(() => screen.getByText('Text moved'));
    expect(badge.getAttribute('title')).toMatch(/text this comment was attached to has changed/);
    expect(screen.getByTestId(`comment-thread-${ids[0]}`).contains(badge)).toBe(true);
  });
});

describe('CommentsPanel — inline composer', () => {
  function renderWithComposer(onSubmit: (body: string) => void, onCancel: () => void) {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'Hello, world!');
    return render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
        composer={{ preview: 'Hello' }}
        onComposerSubmit={onSubmit}
        onComposerCancel={onCancel}
      />,
    );
  }

  it('is absent unless the host opens it', () => {
    const doc = new Y.Doc();
    render(
      <CommentsPanel
        ydoc={doc}
        userId="me"
        userName="Me"
        canWrite={true}
        onJump={() => {}}
        showResolved={false}
        setShowResolved={() => {}}
      />,
    );
    expect(screen.queryByTestId('comment-composer')).toBeNull();
  });

  it('shows the selection preview, focuses the field, and submits the trimmed body on Enter', () => {
    const onSubmit = vi.fn();
    renderWithComposer(onSubmit, () => {});
    expect(screen.getByTestId('comment-composer').textContent).toContain('Hello');
    const input = screen.getByLabelText('New comment') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);

    // Empty body cannot be submitted.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByTestId('comment-composer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(input, { target: { value: '  tighten this  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('tighten this');
  });

  it('Shift+Enter inserts a newline instead of submitting; the button submits', () => {
    const onSubmit = vi.fn();
    renderWithComposer(onSubmit, () => {});
    const input = screen.getByLabelText('New comment');
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('comment-composer-submit'));
    expect(onSubmit).toHaveBeenCalledWith('line one');
  });

  it('Escape and the Cancel button both cancel', () => {
    const onCancel = vi.fn();
    renderWithComposer(() => {}, onCancel);
    fireEvent.keyDown(screen.getByLabelText('New comment'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('comment-composer-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
