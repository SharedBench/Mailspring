import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'crypto';
import { McpHttpServer } from '../lib/mcp-http-server';
import { McpClientGrant } from '../lib/mcp-client-authorization';

const PORT = 21983;
const TOKEN = 'mscp_' + 'a'.repeat(64);
const TOKEN_B = 'mscp_' + 'b'.repeat(64);
const now = Date.now();
function grant(token: string, id: string): McpClientGrant {
  return {
    id,
    name: id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    enabled: true,
    accountIds: ['spec-account'],
    accessLevel: 'read-only',
    createdAt: now,
    expiresAt: null,
  };
}
const CLIENT_A = grant(TOKEN, '00000000-0000-0000-0000-000000000001');
const CLIENT_B = grant(TOKEN_B, '00000000-0000-0000-0000-000000000002');

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-http-spec', version: '0.0.1' },
  },
});

function postInitialize(headers: Record<string, string>) {
  return fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initializeBody,
  });
}

describe('McpHttpServer per-client approval', function () {
  beforeEach(function () {
    this.server = new McpHttpServer();
    this.clients = [CLIENT_A, CLIENT_B];
    waitsForPromise(() =>
      this.server.start(PORT, (token: string) =>
        this.clients.find((client: McpClientGrant) => client.tokenHash ===
          createHash('sha256').update(token).digest('hex')) || null
      )
    );
  });

  afterEach(function () {
    waitsForPromise(() => this.server.stop());
  });

  it('denies missing, legacy, and unapproved bearer tokens', function () {
    waitsForPromise(async () => {
      expect((await postInitialize({})).status).toBe(401);
      expect((await postInitialize({ Authorization: 'Bearer spec-bearer-token' })).status).toBe(401);
      expect((await postInitialize({ Authorization: 'Bearer mscp_' + 'c'.repeat(64) })).status).toBe(401);
    });
  });

  it('does not accept any request without authorization even for other paths', function () {
    waitsForPromise(async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/other`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });

  it('allows an individually approved client to discover tools but no attachment resource', function () {
    waitsForPromise(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      const client = new Client({ name: 'approved-spec', version: '0.0.1' });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain('list_accounts');
        // 只读 grant 不包含附件：不会触发文件系统读取。
        const attachment = await client.callTool({
          name: 'get_attachment',
          arguments: { messageId: 'not-authorized', fileId: 'not-authorized' },
        });
        expect(attachment.isError).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  it('does not allow a second approved client to use the first client session', function () {
    waitsForPromise(async () => {
      const initialized = await postInitialize({ Authorization: `Bearer ${TOKEN}` });
      expect(initialized.status).toBeLessThan(400);
      const sessionId = initialized.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const crossed = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN_B}`,
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(crossed.status).toBe(403);
    });
  });

  it('fails closed after a client is revoked', function () {
    waitsForPromise(async () => {
      const ok = await postInitialize({ Authorization: `Bearer ${TOKEN}` });
      expect(ok.status).toBeLessThan(400);
      this.clients = [CLIENT_B];
      const revoked = await postInitialize({ Authorization: `Bearer ${TOKEN}` });
      expect(revoked.status).toBe(401);
    });
  });
});
