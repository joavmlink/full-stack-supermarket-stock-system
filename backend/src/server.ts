import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface RunningServer {
  port: number;
  server: Server;
  /** Stops accepting connections and runs `onClose`. Safe to call more than once. */
  close(): Promise<void>;
}

export function startServer(options: {
  app: Express;
  port: number;
  host?: string;
  onClose?: () => Promise<void>;
}): Promise<RunningServer> {
  const server = createServer(options.app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      let closing: Promise<void> | undefined;
      const close = () => {
        closing ??= new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
          // Keep-alive sockets with no request in flight would hold close() open.
          server.closeIdleConnections();
          // onClose (closing the database) runs even if server.close() fails.
        }).finally(() => options.onClose?.());
        return closing;
      };
      resolve({ port: (server.address() as AddressInfo).port, server, close });
    });
  });
}
