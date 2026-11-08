import * as http from 'http';
import { randomUUID } from 'crypto';
import { McpClientGrant, withMcpClient } from './mcp-client-authorization';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools, registerResources } from './mcp-tools';

export class McpHttpServer {
  private httpServer: http.Server | null = null;
  private transports: Record<string, { transport: StreamableHTTPServerTransport; clientId: string; tokenHash: string }> = {};

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

    this.httpServer = http.createServer(async (req, res) => {
      // Only allow the /mcp endpoint
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // 客户端独立强凭据；共享的 core.mcp.token 不再有任何权限。
      const authorization = req.headers['authorization'];
      const rawHeader = typeof authorization === 'string' ? authorization : '';
      const match = /^Bearer (mscp_[0-9a-f]{64})$/.exec(rawHeader);
      const bearer = match ? match[1] : '';
      const client = bearer ? authorize(bearer) : null;
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
          JSON.stringify(current.accountIds) === JSON.stringify(client.accountIds)
        );
      };

      // Safety timeout: if the response hasn't been sent after 2 minutes, end it
      // to prevent hanging connections from blocking the server.
      const safetyTimer = setTimeout(() => {
        if (!res.writableEnded) {
          console.error('[MCP Server] Response timeout — forcibly ending hung response');
          res.end();
        }
      }, 120000);
      res.on('close', () => clearTimeout(safetyTimer));

      try {
        // Look up existing session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId && this.transports[sessionId]) {
          const session = this.transports[sessionId];
          if (session.clientId !== client.id || session.tokenHash !== client.tokenHash) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session belongs to another client' }));
            return;
          }
          transport = session.transport;
        } else if (req.method === 'POST') {
          // Parse body to check if this is an initialize request
          const body = await new Promise<string>((resolve) => {
            let data = '';
            req.on('data', (chunk: Buffer) => (data += chunk));
            req.on('end', () => resolve(data));
          });

          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32700, message: 'Parse error' },
                id: null,
              })
            );
            return;
          }

          if (
            isInitializeRequest(parsed) ||
            (Array.isArray(parsed) && parsed.some(isInitializeRequest))
          ) {
            // New session — create a fresh transport and server
            // Reject requests whose Host header isn't loopback. A DNS rebinding
            // attack points a hostname the browser trusts (evil.com) at 127.0.0.1,
            // so the browser still sends `Host: evil.com` — which fails this check.
            // These two values are the only Hosts a legitimate client can send,
            // since we listen on 127.0.0.1 alone.
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableDnsRebindingProtection: true,
              allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
              onsessioninitialized: (sid: string) => {
                this.transports[sid] = { transport: newTransport, clientId: client.id, tokenHash: client.tokenHash };
              },
            });
            newTransport.onclose = () => {
              const sid = newTransport.sessionId;
              if (sid) delete this.transports[sid];
            };
            transport = newTransport;

            const server = this._createServer();
            await withMcpClient(client, stillAuthorized, async () => {
              await server.connect(transport);
              if (!stillAuthorized()) throw new Error('MCP client authorization was revoked');
              await transport.handleRequest(req, res, parsed);
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

        await withMcpClient(client, stillAuthorized, () => transport.handleRequest(req, res));
      } catch (err) {
        console.error('[MCP Server] Error handling request:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });
      this.httpServer.listen(port, '127.0.0.1', () => {
        console.log(`[MCP Server] Listening on http://127.0.0.1:${port}/mcp`);
        resolve();
      });
    });
  }

  async invalidateSessions(): Promise<void> {
    const sessions = Object.values(this.transports);
    this.transports = {};
    for (const session of sessions) {
      try {
        await session.transport.close();
      } catch {
        // 已撤销的会话不能恢复授权。
      }
    }
  }

  async stop(): Promise<void> {
    await this.invalidateSessions();

    if (this.httpServer) {
      return new Promise<void>((resolve) => {
        this.httpServer.close(() => {
          this.httpServer = null;
          resolve();
        });
      });
    }
  }

  isRunning(): boolean {
    return this.httpServer?.listening ?? false;
  }
}
