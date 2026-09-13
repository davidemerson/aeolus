import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  loadDoc,
  persistUpdateBatch,
  snapshotDoc,
  type CrdtDeps,
  type PendingUpdate,
} from '@aeolus/crdt';

import type { Connection } from './connection.js';
import { createLogger, type WsLogger } from './log.js';

export const SNAPSHOT_UPDATE_THRESHOLD = 200;
export const SNAPSHOT_IDLE_MS = 5 * 60 * 1000;

// Backpressure ceiling. Each pending update carries the full Yjs
// update bytes (typically <1 KB but unbounded), so an unbounded
// queue translates directly to memory growth on a slow DB.
// Reaching this means we can't keep up; close every connection
// in the room with WS code 1013 (try-again-later) so the client
// reconnects and reloads the snapshot.
export const MAX_PENDING_UPDATES = 5_000;

export interface Room {
  // Yjs-doc identifier — the room's persistence key. Per ADR 0013
  // this is no longer the docs.id; it's a doc_files row's
  // yjs_doc_id (which equals docs.id for the main file of every
  // phase-1-backfilled doc).
  readonly yjsDocId: string;
  // The parent doc this room belongs to. Used for compile-event
  // fan-out (one compile event lights up every room in the doc,
  // not just the entrypoint file's). Several rooms may share a
  // docId once multi-text-file editing lands.
  readonly docId: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Set<Connection>;
  nextSeq: bigint;
  pendingUpdates: number;
  lastUpdateAt: number;
  persistChain: Promise<void>;
  // Updates accepted but not yet INSERTed. Each drain cycle
  // splices the whole array so further enqueues during the cycle
  // accumulate for the next one.
  pendingBatch: PendingUpdate[];
  draining: boolean;
  snapshotInFlight: boolean;
  idleTimer: NodeJS.Timeout | null;
  destroyed: boolean;
  // Where this room's persist failures and backpressure events go.
  readonly logger: WsLogger;
}

export async function createRoom(
  deps: CrdtDeps,
  yjsDocId: string,
  docId: string,
  logger: WsLogger = createLogger(),
): Promise<Room> {
  const loaded = await loadDoc(deps, yjsDocId);
  const awareness = new awarenessProtocol.Awareness(loaded.doc);
  awareness.setLocalState(null);
  return {
    yjsDocId,
    docId,
    doc: loaded.doc,
    awareness,
    connections: new Set(),
    nextSeq: loaded.nextSeq,
    pendingUpdates: 0,
    lastUpdateAt: Date.now(),
    persistChain: Promise.resolve(),
    pendingBatch: [],
    draining: false,
    snapshotInFlight: false,
    idleTimer: null,
    destroyed: false,
    logger,
  };
}

export function enqueuePersist(
  deps: CrdtDeps,
  room: Room,
  update: Uint8Array,
  authorId: string | null,
): bigint {
  const seq = room.nextSeq;
  room.nextSeq = room.nextSeq + 1n;
  room.pendingUpdates += 1;
  room.lastUpdateAt = Date.now();
  const buffered = new Uint8Array(update);
  room.pendingBatch.push({ seq, update: buffered, authorId });

  if (room.pendingBatch.length >= MAX_PENDING_UPDATES) {
    // We're more than MAX_PENDING_UPDATES updates behind the DB.
    // Continuing to accept writes would just grow heap. Close every
    // connection in the room with 1013 so the client retries against
    // a (presumably) recovered server. The drain that's already
    // in flight finishes the queue.
    room.logger.error(
      { yjsDocId: room.yjsDocId, docId: room.docId, pending: room.pendingBatch.length },
      'persist queue full; closing connections with 1013',
    );
    for (const conn of room.connections) {
      try {
        conn.socket.close(1013, 'persist queue full');
      } catch {
        // socket may already be closed
      }
    }
  }

  if (!room.draining) {
    room.draining = true;
    room.persistChain = room.persistChain
      .catch(() => undefined)
      .then(() => drainPendingBatch(deps, room));
  }
  return seq;
}

async function drainPendingBatch(deps: CrdtDeps, room: Room): Promise<void> {
  try {
    while (room.pendingBatch.length > 0) {
      // Splice everything currently buffered into the next
      // round-trip. New enqueues that land while persistUpdateBatch
      // is awaiting accumulate for the subsequent iteration.
      const batch = room.pendingBatch.splice(0);
      try {
        await persistUpdateBatch(deps, room.yjsDocId, batch);
      } catch (err) {
        // Previously this catch silently dropped the error and the
        // chain moved on, which made the failure mode "user types,
        // sees other tabs converge, but compile says document
        // source is empty" because nothing reached doc_updates. Log
        // each failed update with full context and ring-buffer
        // them so the diagnostic surface can show the most recent
        // few.
        const message = err instanceof Error ? err.message : String(err);
        for (const item of batch) {
          room.logger.error(
            {
              yjsDocId: room.yjsDocId,
              docId: room.docId,
              seq: item.seq.toString(),
              bytes: item.update.byteLength,
              authorId: item.authorId,
              err,
            },
            'persistUpdateBatch failed',
          );
          recordPersistError({
            docId: room.docId,
            yjsDocId: room.yjsDocId,
            seq: item.seq.toString(),
            bytes: item.update.byteLength,
            authorId: item.authorId,
            message,
            at: Date.now(),
          });
        }
        throw err;
      }
    }
  } finally {
    room.draining = false;
  }
}

export interface PersistErrorRecord {
  docId: string;
  yjsDocId: string;
  seq: string;
  bytes: number;
  authorId: string | null;
  message: string;
  at: number;
}

const RECENT_PERSIST_ERRORS_CAP = 50;
const recentPersistErrors: PersistErrorRecord[] = [];

function recordPersistError(record: PersistErrorRecord): void {
  recentPersistErrors.push(record);
  if (recentPersistErrors.length > RECENT_PERSIST_ERRORS_CAP) {
    recentPersistErrors.shift();
  }
}

export function getRecentPersistErrors(): readonly PersistErrorRecord[] {
  return recentPersistErrors;
}

export async function forceSnapshot(
  deps: CrdtDeps,
  room: Room,
): Promise<{ snapshotSeq: bigint; deletedRows: number } | null> {
  if (room.snapshotInFlight) return null;
  room.snapshotInFlight = true;
  try {
    await room.persistChain.catch(() => undefined);
    const upToSeq = room.nextSeq - 1n;
    if (upToSeq < 0n) return null;
    const result = await snapshotDoc(deps, room.yjsDocId, room.doc, upToSeq);
    room.pendingUpdates = 0;
    return { snapshotSeq: result.snapshotSeq, deletedRows: result.deletedRows };
  } finally {
    room.snapshotInFlight = false;
  }
}
