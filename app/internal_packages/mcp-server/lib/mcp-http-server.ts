import * as http from 'http';
import { randomUUID } from 'crypto';
import { Socket } from 'net';
import { McpClientGrant, withMcpClient } from './mcp-client-authorization';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools, registerResources } from './mcp-tools';

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TIMEOUT_MS = 10000;
const MAX_SESSIONS = 32;

class RequestFailure extends Error {
  constructor(readonly status: number) { super('Request rejected'); }
}

// Apply the same bound to initialization and existing sessions; never leave a
// pending reader alive after a disconnect, deadline, or oversized chunk.
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: RequestFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', aborted);
      req.off('aborted', aborted);
      req.off('close', closed);
      if (error) { req.pause(); reject(error); }
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))); }
        catch { reject(new RequestFailure(400)); }
      }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) finish(new RequestFailure(413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(new RequestFailure(400));
    const closed = () => { if (!req.complete) aborted(); };
    const timer = setTimeout(() => finish(new RequestFailure(408)), BODY_TIMEOUT_MS);
    req.on('data', data);
    req.once('end', end);
    req.once('error', aborted);
    req.once('aborted', aborted);
    req.once('close', closed);
  });
}

export class McpHttpServer {
  private httpServer: http.Server | null = null;
  private transports = new Map<string, { transport: StreamableHTTPServerTransport; grant: McpClientGrant }>();
  private sockets = new Set<Socket>();
  private initializing = 0;
  private sessionGeneration = 0;

  private _createServer(): McpServer {
    const server = new McpServer({
      name: 'mailspring',
      version: '1.0.0',
    });
    registerTools(server);
    registerResources(server);
    return server;
  }

  async start(port: number, authorize: (token: string) => McpClientGrant | null): Promise<void> {
    if (this.httpServer) await this.stop();

    const httpServer = http.createServer(async (req, res) => {
      let freshTransport: StreamableHTTPServerTransport | undefined;
      let reserved = false;
      const safetyTimer = setTimeout(() => req.destroy(), 120000);
      res.once('close', () => clearTimeout(safetyTimer));
      res.once('finish', () => clearTimeout(safetyTimer));
      try {
        const address = httpServer.address();
        const boundPort = typeof address === 'object' && address ? address.port : port;
        const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
        if (!allowedHosts.includes(req.headers.host || '')) throw new RequestFailure(403);
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new RequestFailure(400);
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/mcp') throw new RequestFailure(404);
        // 客户端独立强凭据；共享的 core.mcp.token 不再有任何权限。
        const authorization = req.headers['authorization'];
        const rawHeader = typeof authorization === 'string' ? authorization : '';
        const match = /^Bearer (mscp_[0-9a-f]{64})$/.exec(rawHeader);
        const bearer = match ? match[1] : '';
        const authorized = bearer ? authorize(bearer) : null;
        const client = authorized ? { ...authorized, accountIds: [...authorized.accountIds] } : null;
        const generation = this.sessionGeneration;
        if (!client) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized client' }));
          return;
        }
        // 变更凭据、范围、期限或禁用状态时，原 HTTP 会话不能继承旧授权。
        const stillAuthorized = () => {
          const current = authorize(bearer);
          return (
            !!current &&
            current.id === client.id &&
            current.tokenHash === client.tokenHash &&
            current.accessLevel === client.accessLevel &&
            current.expiresAt === client.expiresAt &&
            JSON.stringify(current.accountIds) === JSON.stringify(client.accountIds) &&
            this.httpServer === httpServer && generation === this.sessionGeneration
          );
        };

        // Look up existing session
        const sessionHeader = req.headers['mcp-session-id'];
        if (sessionHeader !== undefined && (typeof sessionHeader !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionHeader))) {
          throw new RequestFailure(400);
        }
        const sessionId = sessionHeader as string | undefined;
        const parsed = req.method === 'POST' ? await readBody(req) : undefined;
        if (!stillAuthorized()) throw new RequestFailure(401);
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId && this.transports.has(sessionId)) {
          const session = this.transports.get(sessionId)!;
          if (session.grant.id !== client.id || session.grant.tokenHash !== client.tokenHash ||
              session.grant.expiresAt !== client.expiresAt ||
              session.grant.accessLevel !== client.accessLevel ||
              JSON.stringify(session.grant.accountIds) !== JSON.stringify(client.accountIds)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session belongs to another client' }));
            return;
          }
          transport = session.transport;
        } else if (req.method === 'POST') {
          if (
            isInitializeRequest(parsed) ||
            (Array.isArray(parsed) && parsed.some(isInitializeRequest))
          ) {
            if (sessionId) throw new RequestFailure(400);
            if (this.transports.size + this.initializing >= MAX_SESSIONS) throw new RequestFailure(429);
            this.initializing += 1;
            reserved = true;
            // New session — create a fresh transport and server
            // Reject requests whose Host header isn't loopback. A DNS rebinding
            // attack points a hostname the browser trusts (evil.com) at 127.0.0.1,
            // so the browser still sends `Host: evil.com` — which fails this check.
            // These two values are the only Hosts a legitimate client can send,
            // since we listen on 127.0.0.1 alone.
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableDnsRebindingProtection: true,
              allowedHosts,
              allowedOrigins: allowedHosts.map((host) => `http://${host}`),
              onsessioninitialized: (sid: string) => {
                if (!stillAuthorized()) throw new RequestFailure(401);
                this.transports.set(sid, { transport: newTransport, grant: client });
              },
            });
            newTransport.onclose = () => {
              const sid = newTransport.sessionId;
              if (sid) this.transports.delete(sid);
            };
            freshTransport = newTransport;
            transport = newTransport;

            const server = this._createServer();
            await withMcpClient(client, stillAuthorized, async () => {
              await server.connect(newTransport);
              if (!stillAuthorized()) throw new Error('MCP client authorization was revoked');
              await newTransport.handleRequest(req, res, parsed);
            });
            return;
          } else if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
              })
            );
            return;
          }
        }

        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: Invalid or missing session' },
              id: null,
            })
          );
          return;
        }

        await withMcpClient(client, stillAuthorized, () => transport.handleRequest(req, res, parsed));
      } catch (err) {
        // Never log request bodies, bearer credentials, or raw SDK exceptions.
        const status = err instanceof RequestFailure ? err.status : 500;
        if (freshTransport) await freshTransport.close().catch(() => undefined);
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
          res.once('finish', () => req.destroy());
          res.end(JSON.stringify({ error: status === 500 ? 'Internal server error' : 'Request rejected' }));
        } else if (!res.writableEnded) {
          res.end();
        }
      } finally {
        if (reserved) this.initializing -= 1;
      }
    });
    this.httpServer = httpServer;
    httpServer.maxConnections = 64;
    httpServer.headersTimeout = BODY_TIMEOUT_MS;
    httpServer.requestTimeout = BODY_TIMEOUT_MS;
    httpServer.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });

    return new Promise<void>((resolve, reject) => {
      httpServer.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });
      httpServer.listen(port, '127.0.0.1', () => {
        console.log(`[MCP Server] Listening on http://127.0.0.1:${port}/mcp`);
        resolve();
      });
    });
  }

  async invalidateSessions(): Promise<void> {
    this.sessionGeneration += 1;
    const sessions = [...this.transports.values()];
    this.transports.clear();
    for (const session of sessions) {
      try {
        await session.transport.close();
      } catch {
        // 已撤销的会话不能恢复授权。
      }
    }
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    // Detach before any await so in-flight initialization cannot revive a session.
    this.httpServer = null;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await this.invalidateSessions();
    await closed;
  }

  isRunning(): boolean {
    return this.httpServer?.listening ?? false;
  }
}
