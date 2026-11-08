import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';

const PORT = 21985;
const TOKEN = 'insecure-shared-bearer-no-longer-accepted';
const BRIDGE = path.join(__dirname, '..', 'lib', 'mcp-stdio-bridge.js');

interface JsonRpcMessage {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

// 旧 stdio 桥仅保留拒绝路径；不应再以共享令牌注册新的 MCP 客户端。
class BridgeClient {
  child: ChildProcess;
  received: JsonRpcMessage[] = [];
  stderr = '';
  private waiters: (() => void)[] = [];
  private buffered = '';

  constructor(configDir: string) {
    this.child = spawn(process.execPath, [BRIDGE, '--config-dir', configDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffered += chunk;
      let newline: number;
      while ((newline = this.buffered.indexOf('\n')) !== -1) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.trim()) this.received.push(JSON.parse(line));
      }
      this.waiters.splice(0).forEach((w) => w());
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
  }

  send(message: object) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  response(id: number): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      const check = () => {
        const match = this.received.find((m) => m.id === id);
        if (match) resolve(match);
        else this.waiters.push(check);
      };
      check();
    });
  }

  async initialize() {
    this.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bridge-spec', version: '0.0.1' },
      },
    });
    return this.response(1);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.child.on('exit', () => resolve());
      this.child.stdin.end();
    });
  }
}

describe('mcp-stdio-bridge parseEventStream', function () {
  const { parseEventStream } = require('../lib/mcp-stdio-bridge.js');

  it('extracts JSON-RPC messages from SSE events, including multi-line and CRLF data', function () {
    const body = [
      'event: message',
      'id: 1',
      'data: {"jsonrpc":"2.0","method":"notifications/progress",',
      'data: "params":{"progress":1}}',
      '',
      ': keepalive comment',
      '',
      'data:{"jsonrpc":"2.0","id":7,"result":{}}',
      '',
    ].join('\r\n');
    expect(parseEventStream(body)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]);
  });

  it('keeps a final event that has no trailing blank line and skips unparseable ones', function () {
    const body = 'data: not json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}';
    expect(parseEventStream(body)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
});

describe('mcp-stdio-bridge legacy refusal', function () {
  beforeEach(function () {
    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailspring-bridge-spec-'));
    fs.writeFileSync(
      path.join(this.configDir, 'config.json'),
      JSON.stringify({ '*': { core: { mcp: { enabled: true, port: PORT, token: TOKEN } } } })
    );
  });

  afterEach(function () {
    fs.rmSync(this.configDir, { recursive: true, force: true });
  });

  it('refuses legacy shared bearer without contacting the mail server', function () {
    waitsForPromise(async () => {
      const client = new BridgeClient(this.configDir);
      try {
        const init = await client.initialize();
        expect(init.error).toBeDefined();
        expect(init.error!.message).toContain('旧 Mailspring stdio 桥');
        expect(client.child.exitCode).toBeNull();
      } finally {
        await client.close();
      }
    });
  });

  it('fails clearly when MCP is disabled', function () {
    waitsForPromise(async () => {
      fs.writeFileSync(
        path.join(this.configDir, 'config.json'),
        JSON.stringify({ '*': { core: { mcp: { enabled: false, port: PORT, token: TOKEN } } } })
      );
      const client = new BridgeClient(this.configDir);
      try {
        const init = await client.initialize();
        expect(init.error!.message).toContain('turned off');
      } finally {
        await client.close();
      }
    });
  });

  it('keeps handling calls as errors rather than resurrecting revoked authority', function () {
    waitsForPromise(async () => {
      const client = new BridgeClient(this.configDir);
      try {
        expect((await client.initialize()).error).toBeDefined();
        client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect((await client.response(2)).error).toBeDefined();
      } finally {
        await client.close();
      }
    });
  });
});
