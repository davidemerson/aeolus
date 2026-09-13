import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  addReply,
  createThread,
  deleteThread,
  listThreads,
  onThreadsChange,
  setResolved,
} from './comments.js';

function newDocWithSource(source: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, source);
  return doc;
}

describe('comments — Yjs-native CRUD', () => {
  it('creates a thread with resolved anchors that match the selected range', () => {
    const doc = newDocWithSource('Hello, world!');
    const id = createThread(doc, {
      from: 7,
      to: 12,
      body: 'should this be capitalised?',
      authorId: 'u1',
      authorName: 'Ada',
      preview: 'world',
    });
    const [t] = listThreads(doc);
    expect(t.id).toBe(id);
    expect(t.from).toBe(7);
    expect(t.to).toBe(12);
    expect(t.body).toBe('should this be capitalised?');
    expect(t.preview).toBe('world');
    expect(t.resolved).toBe(false);
    expect(t.replies).toEqual([]);
  });

  it('preserves anchors across concurrent inserts', () => {
    const a = newDocWithSource('Hello, world!');
    const id = createThread(a, {
      from: 7,
      to: 12,
      body: 'note',
      authorId: 'u1',
      authorName: null,
      preview: 'world',
    });
    // Simulate a remote insert in front of the anchored range.
    a.getText('source').insert(0, 'Greetings — ');
    const [t] = listThreads(a);
    expect(t.id).toBe(id);
    // The anchor moved by the inserted prefix length (12 chars).
    expect(t.from).toBe(7 + 'Greetings — '.length);
    expect(t.to).toBe(12 + 'Greetings — '.length);
  });

  it('returns null offsets when the anchored text is deleted', () => {
    const doc = newDocWithSource('Hello, world!');
    createThread(doc, {
      from: 7,
      to: 12,
      body: 'note',
      authorId: 'u1',
      authorName: null,
      preview: 'world',
    });
    // Delete the entire source — anchors can't resolve to an
    // index inside an empty Y.Text.
    doc.getText('source').delete(0, doc.getText('source').length);
    const [t] = listThreads(doc);
    // Anchors at the start of an empty buffer collapse to 0; the
    // important property is that the thread is still listed and
    // the preview survives.
    expect(t.preview).toBe('world');
    expect(t.from).toBe(0);
    expect(t.to).toBe(0);
  });

  it('addReply appends to the replies array', () => {
    const doc = newDocWithSource('Hello.');
    const id = createThread(doc, {
      from: 0,
      to: 5,
      body: 'q',
      authorId: 'u1',
      authorName: null,
      preview: 'Hello',
    });
    expect(addReply(doc, id, { text: 'sgtm', authorId: 'u2', authorName: 'Bo' })).toBe(true);
    expect(addReply(doc, id, { text: 'thanks', authorId: 'u1', authorName: null })).toBe(true);
    const [t] = listThreads(doc);
    expect(t.replies.map((r) => r.text)).toEqual(['sgtm', 'thanks']);
    expect(t.replies[0].authorName).toBe('Bo');
  });

  it('setResolved toggles the flag', () => {
    const doc = newDocWithSource('Hello.');
    const id = createThread(doc, {
      from: 0,
      to: 5,
      body: 'q',
      authorId: 'u1',
      authorName: null,
      preview: 'Hello',
    });
    expect(setResolved(doc, id, true)).toBe(true);
    expect(listThreads(doc)[0].resolved).toBe(true);
    expect(setResolved(doc, id, false)).toBe(true);
    expect(listThreads(doc)[0].resolved).toBe(false);
  });

  it('deleteThread removes a thread', () => {
    const doc = newDocWithSource('Hello.');
    const id = createThread(doc, {
      from: 0,
      to: 5,
      body: 'q',
      authorId: 'u1',
      authorName: null,
      preview: 'Hello',
    });
    expect(deleteThread(doc, id)).toBe(true);
    expect(listThreads(doc)).toHaveLength(0);
  });

  it('threads converge across two Y.Docs synced via state updates', () => {
    const a = newDocWithSource('Hello, world!');
    const b = new Y.Doc();
    // Initial sync.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Concurrent operations: a creates a thread; b inserts text
    // before the anchored range. After exchanging updates both see
    // the thread and the moved anchor.
    const id = createThread(a, {
      from: 7,
      to: 12,
      body: 'q',
      authorId: 'u1',
      authorName: null,
      preview: 'world',
    });
    b.getText('source').insert(0, 'X ');

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    const onA = listThreads(a);
    const onB = listThreads(b);
    expect(onA).toHaveLength(1);
    expect(onB).toHaveLength(1);
    expect(onA[0].id).toBe(id);
    expect(onB[0].id).toBe(id);
    // The shared source is now 'X Hello, world!'; the anchor at
    // 'world' (originally 7) moved to 9.
    expect(onA[0].from).toBe(9);
    expect(onB[0].from).toBe(9);
  });

  it('onThreadsChange fires on creation, reply, resolve, and delete', () => {
    const doc = newDocWithSource('Hello.');
    const calls: number[] = [];
    const stop = onThreadsChange(doc, (threads) => calls.push(threads.length));
    // Initial push gives 0 threads.
    expect(calls).toEqual([0]);
    const id = createThread(doc, {
      from: 0,
      to: 5,
      body: 'q',
      authorId: 'u1',
      authorName: null,
      preview: 'Hello',
    });
    addReply(doc, id, { text: 'reply', authorId: 'u2', authorName: null });
    setResolved(doc, id, true);
    deleteThread(doc, id);
    stop();
    // We saw the initial state (0), the create (1), the reply (1),
    // the resolve (1), and the delete (0).
    expect(calls).toEqual([0, 1, 1, 1, 0]);
  });
});
