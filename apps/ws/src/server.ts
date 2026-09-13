import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';

import { and, eq, gt } from 'drizzle-orm';
import * as encoding from 'lib0/encoding';
import type { Pool, PoolClient } from 'pg';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocket, WebSocketServer } from 'ws';

import {
  assertCanRead,
  createDbAclDeps,
  createSessionStore,
  type AclDeps,
  type SessionStore,
} from '@aeolus/auth';
import type { CrdtDeps } from '@aeolus/crdt';
import { docFiles, users, wsTickets, type Database } from '@aeolus/db';

import { createConnection, sendBinary, type Connection } from './connection.js';
import { createCookieUnsigner, extractSessionToken, type CookieUnsigner } from './cookie.js';
import { createLogger, type WsLogger } from './log.js';
import {
  encodeAwarenessFull,
  encodeSyncStep1,
  encodeSyncUpdate,
  handleIncomingMessage,
  messageAwareness,
} from './protocol.js';
import {
  SNAPSHOT_IDLE_MS,
  SNAPSHOT_UPDATE_THRESHOLD,
  createRoom,
  enqueuePersist,
  getRecentPersistErrors,
  forceSnapshot,
  type Room,
} from './room.js';

const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

export interface BuildWsServerDeps {
  db: Database;
  // Pool used both for ACL/CRDT queries and for the dedicated
  // LISTEN client that fans out compile events to ws clients.
  dbPool: Pool;
  blobs: CrdtDeps['blobs'];
  cookieSecret: string;
  sessionStore?: SessionStore;
  aclDeps?: AclDeps;
  snapshotUpdateThreshold?: number;
  snapshotIdleMs?: number;
  // Structured operational log line (upgrade accepted/rejected).
  // Injectable so tests can capture; defaults to `logger.info`.
  log?: (line: string) => void;
  // pino instance for everything else (persist failures, upgrade
  // errors, listen-client errors). Defaults to createLogger().
  logger?: WsLogger;
  // Origins allowed to open a socket on the COOKIE fallback path. A
  // WebSocket upgrade is not subject to CORS, and the browser attaches
  // the session cookie to it, so without this any page on the internet
  // could open an authenticated Yjs socket from a signed-in browser.
  // Browsers always send Origin on an upgrade; a request without one
  // (a Node client, the tests) is not a browser and passes. The ticket
  // path is unaffected — a ticket is minted by a cookie-gated POST the
  // browser would only make from the app. Unset = no check (tests).
  allowedOrigins?: readonly string[];
}

export interface WsServerHandle {
  httpServer: HttpServer;
  wss: WebSocketServer;
  address(): { port: number; host: string };
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
  // forceSnapshot accepts the legacy docId for backwards
  // compatibility with tests; it snapshots every room owned by
  // that doc (typically just the main file's room).
  forceSnapshot(docId: string): Promise<{ snapshotSeq: bigint; deletedRows: number } | null>;
  roomCount(): number;
}

export function createWsServer(deps: BuildWsServerDeps): WsServerHandle {
  const sessionStore = deps.sessionStore ?? createSessionStore(deps.db);
  const aclDeps = deps.aclDeps ?? createDbAclDeps(deps.db);
  const unsigner: CookieUnsigner = createCookieUnsigner(deps.cookieSecret);
  const logger = deps.logger ?? createLogger();
  const log = deps.log ?? ((line: string) => logger.info(line));
  const crdtDeps: CrdtDeps = { db: deps.db, blobs: deps.blobs };
  const updateThreshold = deps.snapshotUpdateThreshold ?? SNAPSHOT_UPDATE_THRESHOLD;
  const idleMs = deps.snapshotIdleMs ?? SNAPSHOT_IDLE_MS;

  // Rooms are keyed on yjs_doc_id (the per-file Yjs persistence
  // identifier from doc_files). Multiple rooms can share a docId
  // once a project has more than one text file.
  const rooms = new Map<string, Room>();
  const roomLoads = new Map<string, Promise<Room>>();

  // Dedicated long-lived pg client subscribing to NOTIFY traffic on
  // ROOM_EVICT_CHANNEL. We can't use the pool's checkout/return pattern
  // here — LISTEN binds to a single backend connection.
  //
  // Compile-finish events are intentionally NOT pushed over this socket
  // (issue #59). It carries the binary y-websocket protocol, and the stock
  // y-websocket client feeds every inbound frame straight into lib0's sync
  // decoder — a JSON *text* frame decodes to a zero-filled buffer and throws
  // "Unexpected end of array", which kills the editor render (and thus the PDF
  // preview). The editor already learns compile status by polling the compile
  // API (useCompileLifecycle), so the push was redundant as well as fatal. A
  // real server push would need a transport separate from the Yjs socket.
  let listenClient: PoolClient | null = null;
  let listenClosed = false;

  // Issue #52: when the api process applies a checkpoint restore, it
  // writes the diff to doc_updates but the WS room's in-memory Y.Doc
  // doesn't pick it up — connected editors see stale content until
  // the room is evicted from cache and re-loaded from DB. Listen on
  // a second channel that api NOTIFYs on after a successful restore;
  // payload is the yjsDocId. Channel name duplicated in
  // apps/api/src/routes/checkpoints.ts and project-checkpoints.ts;
  // there's no shared package both can import without dragging api
  // through ws or vice versa, and a single string constant isn't
  // worth the abstraction.
  const ROOM_EVICT_CHANNEL = 'aeolus_room_evict' as const;

  async function evictRoom(yjsDocId: string): Promise<void> {
    const room = rooms.get(yjsDocId);
    if (!room) return;
    room.destroyed = true;
    if (room.idleTimer) clearTimeout(room.idleTimer);
    // Wait for any in-flight persists so an eviction triggered right
    // after a user keystroke doesn't drop their last edit.
    await room.persistChain.catch(() => undefined);
    // Close every connection with 1012 (service restart). y-websocket
    // auto-reconnects on close regardless of code; the SPA's existing
    // close-handler treats 1008 as auth-failed but lets every other
    // non-clean code fall through to the default retry path. Each
    // reconnect goes through getOrCreateRoom, which re-loads from DB
    // — including the just-restored update.
    for (const conn of room.connections) {
      try {
        conn.socket.close(1012, 'room_evicted');
      } catch {
        /* ignore */
      }
    }
    room.connections.clear();
    rooms.delete(yjsDocId);
    room.doc.destroy();
  }

  async function startListenClient(): Promise<void> {
    if (listenClosed) return;
    const client = await deps.dbPool.connect();
    listenClient = client;
    client.on('notification', (msg) => {
      if (msg.channel === ROOM_EVICT_CHANNEL && msg.payload) {
        // Payload is the yjsDocId. No JSON wrapper — eviction has no
        // other fields to carry.
        void evictRoom(msg.payload);
        return;
      }
    });
    client.on('error', (err) => {
      logger.error({ err }, 'listen client error; reconnecting in 1s');
      // Drop the broken client and reconnect after a short delay.
      try {
        client.release(err);
      } catch {
        /* ignore */
      }
      if (listenClient === client) listenClient = null;
      if (!listenClosed) {
        setTimeout(() => {
          void startListenClient();
        }, 1000).unref();
      }
    });
    await client.query(`LISTEN ${ROOM_EVICT_CHANNEL}`);
  }

  void startListenClient();

  async function getOrCreateRoom(yjsDocId: string, docId: string): Promise<Room> {
    const existing = rooms.get(yjsDocId);
    if (existing) return existing;
    const inflight = roomLoads.get(yjsDocId);
    if (inflight) return inflight;
    const promise = createRoom(crdtDeps, yjsDocId, docId, logger)
      .then((room) => {
        rooms.set(yjsDocId, room);
        wireRoom(room);
        return room;
      })
      .finally(() => {
        roomLoads.delete(yjsDocId);
      });
    roomLoads.set(yjsDocId, promise);
    return promise;
  }

  // Resolve a (docId, optional fileId) pair to the file's
  // yjs_doc_id. When fileId is omitted, pick the main entrypoint
  // (path = main.{tex,typ}) — backwards compatible with clients
  // that haven't learned about fileId. Returns null when no text
  // file matches; the caller turns that into a 1008 close.
  async function resolveYjsDocId(docId: string, fileId: string | null): Promise<string | null> {
    if (fileId) {
      const [row] = await deps.db
        .select({ yjsDocId: docFiles.yjsDocId })
        .from(docFiles)
        .where(and(eq(docFiles.id, fileId), eq(docFiles.docId, docId), eq(docFiles.kind, 'text')))
        .limit(1);
      return row?.yjsDocId ?? null;
    }
    const [main] = await deps.db
      .select({ yjsDocId: docFiles.yjsDocId })
      .from(docFiles)
      .where(and(eq(docFiles.docId, docId), eq(docFiles.kind, 'text')))
      .orderBy(docFiles.createdAt)
      .limit(1);
    return main?.yjsDocId ?? null;
  }

  function wireRoom(room: Room): void {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin && typeof origin === 'object' && 'socket' in origin) {
        const conn = origin as Connection;
        const seq = enqueuePersist(crdtDeps, room, update, conn.userId);
        void seq;
      } else if (origin === null || origin === undefined) {
        enqueuePersist(crdtDeps, room, update, null);
      }
      const message = encodeSyncUpdate(update);
      for (const conn of room.connections) {
        if (conn === origin) continue;
        sendBinary(conn, message);
      }
      scheduleSnapshot(room);
    });

    room.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        if (origin && typeof origin === 'object' && 'socket' in origin) {
          const conn = origin as Connection;
          for (const id of added) conn.awarenessClients.add(id);
          for (const id of removed) conn.awarenessClients.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed),
        );
        const message = encoding.toUint8Array(encoder);
        // Deliberately echoed to the origin connection too (stock
        // y-websocket server semantics). The echo doubles as the
        // keepalive for solo editors: y-websocket's client closes any
        // socket silent for messageReconnectTimeout (30s), and the
        // client renews its awareness state every ~15s — without the
        // echo a solo editor receives nothing after the handshake and
        // churns through a reconnect every ~30s. applyAwarenessUpdate
        // ignores an echoed entry at the sender (equal clock,
        // non-null state), so this is a client-side no-op.
        for (const conn of room.connections) {
          sendBinary(conn, message);
        }
      },
    );
  }

  function scheduleSnapshot(room: Room): void {
    if (room.destroyed) return;
    if (room.pendingUpdates >= updateThreshold && !room.snapshotInFlight) {
      void forceSnapshot(crdtDeps, room).catch(() => undefined);
    }
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      if (room.pendingUpdates > 0 && !room.snapshotInFlight) {
        void forceSnapshot(crdtDeps, room).catch(() => undefined);
      }
    }, idleMs);
    if (typeof room.idleTimer.unref === 'function') {
      room.idleTimer.unref();
    }
  }

  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://ws.local').pathname;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // GET /readyz — dependency check: can this process reach Postgres,
    // and is the LISTEN client (room eviction, #52) alive? The ALB
    // probe stays on /healthz; this exists so an operator or a future
    // probe can tell "up" from "able to do its job" (ADR 0024).
    if (pathname === '/readyz') {
      void (async () => {
        const checks: Record<string, boolean> = { db: false, listen: listenClient !== null };
        try {
          await Promise.race([
            deps.dbPool.query('SELECT 1'),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('db probe timed out')), 2_000).unref(),
            ),
          ]);
          checks.db = true;
        } catch (err) {
          logger.warn({ err }, 'readyz: db probe failed');
        }
        const ok = Object.values(checks).every(Boolean);
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, checks }));
      })();
      return;
    }
    // GET /diagnostics — admin-only, returns the in-memory ring of
    // recent persistUpdate failures. Cookie-gated; the cookie carries
    // the same session secret api signs, and we already wired the
    // unsigner / sessionStore / aclDeps below for the WS upgrade
    // path. This is the only thing api can call to diagnose
    // ws-side persistence; everything else lives in this process.
    if (pathname === '/diagnostics') {
      void (async () => {
        try {
          const token = extractSessionToken(req.headers.cookie, unsigner);
          if (!token) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'no_session' }));
            return;
          }
          const session = await sessionStore.get(token);
          if (!session) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_session' }));
            return;
          }
          // Look up the user's admin flag — ws doesn't carry
          // user.isAdmin in the session, and this is the one place
          // it needs it, so a direct read beats plumbing a helper
          // through @aeolus/auth.
          const [row] = await deps.db
            .select({ isAdmin: users.isAdmin })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
          if (!row?.isAdmin) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ts: new Date().toISOString(),
              recent_persist_errors: getRecentPersistErrors(),
              rooms: rooms.size,
            }),
          );
        } catch (err) {
          // The message stays in the log. Before auth has passed this
          // handler is reachable by anyone on the overlay, and a DB
          // error string is not something to hand them.
          process.stderr.write(`[ws] diagnostics error: ${String(err)}\n`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        }
      })();
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });

  const wss = new WebSocketServer({ noServer: true });

  interface UpgradeAuth {
    userId: string;
    docId: string;
    fileId: string | null;
  }

  // Rejections carry whatever context is known at the point of
  // failure so the upgrade handler can log a useful line — userId is
  // only resolvable once the ticket row / session was found.
  interface UpgradeReject {
    error: string;
    docId?: string | null;
    fileId?: string | null;
    userId?: string;
  }

  async function consumeTicket(
    rawTicket: string,
    docId: string,
    fileId: string | null,
  ): Promise<UpgradeAuth | UpgradeReject> {
    const hash = createHash('sha256').update(rawTicket).digest('hex');
    // Renewable consume: tickets are multi-use within their TTL so
    // y-websocket's auto-reconnects (network blip, tab sleep, doc
    // file-switch teardown) don't require minting a fresh ticket
    // for every retry. Single-use was the original design but
    // produced a guaranteed-banner bug — y-websocket reuses the
    // same upgrade URL on reconnect, so the second connection
    // always failed and the SPA's two-strike rule fired even on a
    // single network hiccup. consumed_at is still set on every use
    // so telemetry (and future audit-log) can see how often a
    // ticket got reused; the WHERE clause no longer gates on it.
    // After TTL expires the user reloads the editor (which mints a
    // new ticket anyway).
    const rows = await deps.db
      .update(wsTickets)
      .set({ consumedAt: new Date() })
      .where(and(eq(wsTickets.ticketHash, hash), gt(wsTickets.expiresAt, new Date())))
      .returning({
        userId: wsTickets.userId,
        ticketDocId: wsTickets.docId,
      });
    if (rows.length === 0) return { error: 'invalid_ticket', docId, fileId };
    const row = rows[0]!;
    if (row.ticketDocId !== docId) {
      return { error: 'ticket_doc_mismatch', docId, fileId, userId: row.userId };
    }
    try {
      await assertCanRead(aclDeps, row.userId, docId);
    } catch {
      return { error: 'forbidden', docId, fileId, userId: row.userId };
    }
    return { userId: row.userId, docId, fileId };
  }

  async function authenticateUpgrade(
    request: IncomingMessage,
  ): Promise<UpgradeAuth | UpgradeReject> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const docId = url.searchParams.get('docId');
    if (!docId) return { error: 'missing_doc' };
    // Optional per-file selector. Backwards-compatible: clients
    // that don't pass fileId get routed to the main entrypoint.
    const fileId = url.searchParams.get('fileId');

    // Ticket path (preferred): the SPA fetches a one-shot bearer
    // from /api/ws/ticket and includes it in the upgrade URL. Cookie
    // is NOT required, so the cross-subdomain Domain-attribute
    // problem doesn't apply here.
    const ticket = url.searchParams.get('ticket');
    if (ticket) {
      return consumeTicket(ticket, docId, fileId);
    }

    // Cookie fallback: same-origin / single-host setups (tests, dev)
    // can still upgrade with just the session cookie — from the app's
    // own origin.
    const origin = request.headers.origin;
    if (
      deps.allowedOrigins &&
      typeof origin === 'string' &&
      !deps.allowedOrigins.includes(origin)
    ) {
      return { error: 'bad_origin', docId, fileId };
    }
    const token = extractSessionToken(request.headers.cookie, unsigner);
    if (!token) return { error: 'no_session', docId, fileId };
    const session = await sessionStore.get(token);
    if (!session) return { error: 'invalid_session', docId, fileId };
    try {
      await assertCanRead(aclDeps, session.userId, docId);
    } catch {
      return { error: 'forbidden', docId, fileId, userId: session.userId };
    }
    return { userId: session.userId, docId, fileId };
  }

  const toBuffer = (data: unknown): Uint8Array =>
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : new Uint8Array(data as Buffer);

  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.binaryType = 'arraybuffer';
      const earlyMessages: Uint8Array[] = [];
      const earlyListener = (data: unknown): void => {
        earlyMessages.push(toBuffer(data));
      };
      ws.on('message', earlyListener);

      authenticateUpgrade(request)
        .then(async (result) => {
          if ('error' in result) {
            ws.off('message', earlyListener);
            log(
              `[ws] upgrade_rejected reason=${result.error}` +
                ` docId=${result.docId ?? '-'} fileId=${result.fileId ?? '-'}` +
                ` user=${result.userId?.slice(0, 8) ?? '-'}`,
            );
            ws.close(POLICY_VIOLATION, result.error);
            return;
          }
          // Translate (docId, optional fileId) → yjs_doc_id. Bad
          // fileId → 1008 unknown_file. Missing main entrypoint
          // (no doc_files row) → 1008 no_text_file.
          const yjsDocId = await resolveYjsDocId(result.docId, result.fileId);
          if (!yjsDocId) {
            ws.off('message', earlyListener);
            const reason = result.fileId ? 'unknown_file' : 'no_text_file';
            log(
              `[ws] upgrade_rejected reason=${reason}` +
                ` docId=${result.docId} fileId=${result.fileId ?? '-'}` +
                ` user=${result.userId.slice(0, 8)}`,
            );
            ws.close(POLICY_VIOLATION, reason);
            return;
          }
          log(
            `[ws] upgrade_accepted docId=${result.docId}` +
              ` yjsDocId=${yjsDocId} user=${result.userId.slice(0, 8)}`,
          );
          // The early listener stays attached until handleConnection has
          // the room and swaps in the real one. Detaching here, before
          // the room load (a DB round-trip plus a possible S3 GET for
          // the snapshot), opened a window in which every frame the
          // client sent was silently dropped — including its sync
          // step 1, so it never received the server's state and opened
          // an empty document until the next reconnect.
          await handleConnection(ws, result.userId, result.docId, yjsDocId, {
            earlyListener,
            earlyMessages,
          });
        })
        .catch((err) => {
          ws.off('message', earlyListener);
          ws.close(INTERNAL_ERROR, 'internal_error');
          logger.error({ err }, 'upgrade error');
        });
    });
  });

  async function handleConnection(
    socket: WebSocket,
    userId: string,
    docId: string,
    yjsDocId: string,
    early: { earlyListener: (data: unknown) => void; earlyMessages: Uint8Array[] },
  ): Promise<void> {
    const room = await getOrCreateRoom(yjsDocId, docId);
    if (socket.readyState !== WebSocket.OPEN) {
      socket.off('message', early.earlyListener);
      return;
    }
    const conn = createConnection(socket, userId, docId);
    room.connections.add(conn);

    // Swap listeners in one synchronous step. No frame can arrive
    // between these two statements, so `early.earlyMessages` is
    // complete once the real handler is on and nothing is lost.
    socket.on('message', (data) => {
      try {
        const buffer = toBuffer(data);
        const { reply } = handleIncomingMessage(buffer, room.doc, room.awareness, conn);
        if (reply) sendBinary(conn, reply);
      } catch (err) {
        logger.error({ err, docId, yjsDocId }, 'message error');
      }
    });
    socket.off('message', early.earlyListener);

    const handleClose = (): void => {
      if (!room.connections.has(conn)) return;
      room.connections.delete(conn);
      if (conn.awarenessClients.size > 0) {
        awarenessProtocol.removeAwarenessStates(
          room.awareness,
          Array.from(conn.awarenessClients),
          conn,
        );
      }
    };
    socket.on('close', handleClose);
    socket.on('error', handleClose);

    sendBinary(conn, encodeSyncStep1(room.doc));
    const awarenessMessage = encodeAwarenessFull(room.awareness);
    if (awarenessMessage) sendBinary(conn, awarenessMessage);

    for (const buffer of early.earlyMessages) {
      try {
        const { reply } = handleIncomingMessage(buffer, room.doc, room.awareness, conn);
        if (reply) sendBinary(conn, reply);
      } catch (err) {
        logger.error({ err, docId, yjsDocId }, 'message error');
      }
    }
  }

  const handle: WsServerHandle = {
    httpServer,
    wss,
    address() {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        return { port: addr.port, host: addr.address };
      }
      return { port: 0, host: '127.0.0.1' };
    },
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          httpServer.off('listening', onListen);
          reject(err);
        };
        const onListen = (): void => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListen);
        httpServer.listen(port, host);
      });
      return handle.address();
    },
    async close() {
      listenClosed = true;
      for (const room of rooms.values()) {
        room.destroyed = true;
        if (room.idleTimer) clearTimeout(room.idleTimer);
        for (const conn of room.connections) {
          try {
            conn.socket.close(1001, 'server_shutdown');
          } catch {
            /* ignore */
          }
        }
        room.connections.clear();
        await room.persistChain.catch(() => undefined);
        room.doc.destroy();
      }
      rooms.clear();
      if (listenClient) {
        try {
          await listenClient.query(`UNLISTEN ${ROOM_EVICT_CHANNEL}`);
        } catch {
          /* ignore */
        }
        try {
          listenClient.release();
        } catch {
          /* ignore */
        }
        listenClient = null;
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
    async forceSnapshot(docId: string) {
      // Tests may pass either a docId (legacy: equals yjsDocId for
      // every phase-1-backfilled doc) or a yjsDocId. Try the
      // direct map lookup first; if that misses, find a room whose
      // docId matches and snapshot it. Returns the first match —
      // multi-text-file callers should pass yjsDocId directly.
      const direct = rooms.get(docId);
      if (direct) return forceSnapshot(crdtDeps, direct);
      for (const room of rooms.values()) {
        if (room.docId === docId) return forceSnapshot(crdtDeps, room);
      }
      return null;
    },
    roomCount() {
      return rooms.size;
    },
  };

  return handle;
}
