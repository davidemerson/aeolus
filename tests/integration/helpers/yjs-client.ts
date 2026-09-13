import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const messageSync = 0;
const messageAwareness = 1;

export interface YjsTestClient {
  readonly doc: Y.Doc;
  readonly socket: WebSocket;
  waitOpen(): Promise<void>;
  // Send sync step 1 by hand. Only meaningful with `sendSyncStep1OnOpen:
  // false`; the default client sends it the moment the socket opens,
  // exactly like y-websocket does.
  sendSyncStep1(): void;
  waitForText(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  // Default true. Set false to control WHEN step 1 goes out — the
  // connect-window regression test needs it to land after the server
  // has accepted the upgrade but before the room has loaded.
  sendSyncStep1OnOpen?: boolean;
  // Sent as the Origin header, the way a browser would.
  origin?: string;
}

export function connectYjsClient(
  url: string,
  cookie: string,
  options: ConnectOptions = {},
): YjsTestClient {
  const doc = new Y.Doc();
  const socket = new WebSocket(url, {
    headers: options.origin ? { cookie, origin: options.origin } : { cookie },
  });
  socket.binaryType = 'arraybuffer';

  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.once('error', (err) => {
    readyReject?.(err as Error);
  });

  const sendSyncStep1 = (): void => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    socket.send(encoding.toUint8Array(encoder));
  };

  if (options.sendSyncStep1OnOpen !== false) {
    socket.once('open', sendSyncStep1);
  }

  socket.on('message', (data) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Array.isArray(data)
          ? new Uint8Array(Buffer.concat(data))
          : new Uint8Array(data as Buffer);
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === messageSync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    } else if (messageType === messageAwareness) {
      // ignore
    }
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === socket) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  return {
    doc,
    socket,
    sendSyncStep1,
    async waitOpen() {
      await readyPromise;
    },
    async waitForText(predicate, timeoutMs = 5000) {
      const text = doc.getText('source');
      if (predicate(text.toString())) return text.toString();
      return new Promise<string>((resolve, reject) => {
        const to = setTimeout(() => {
          text.unobserve(handler);
          reject(
            new Error(
              `waitForText timeout after ${timeoutMs}ms, current=${JSON.stringify(
                text.toString(),
              )}`,
            ),
          );
        }, timeoutMs);
        const handler = (): void => {
          if (predicate(text.toString())) {
            clearTimeout(to);
            text.unobserve(handler);
            resolve(text.toString());
          }
        };
        text.observe(handler);
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close();
      });
      doc.destroy();
    },
  };
}
