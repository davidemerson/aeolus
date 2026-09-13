import type { WebSocket } from 'ws';

export interface Connection {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly docId: string;
  readonly awarenessClients: Set<number>;
}

export function createConnection(socket: WebSocket, userId: string, docId: string): Connection {
  return {
    socket,
    userId,
    docId,
    awarenessClients: new Set(),
  };
}

export function sendBinary(conn: Connection, message: Uint8Array): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return;
  conn.socket.send(message, { binary: true }, () => undefined);
}
