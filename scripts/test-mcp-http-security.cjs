// 独立 HTTP/SDK 回归；邮件工具明确使用空替身，不访问用户邮箱。
// CHUMEN_MCP_TEST_RUNTIME 指向安装有固定 SDK、TypeScript、@types/node 的独立目录。
// CHUMEN_MCP_TEST_OUTPUT 必须指向任务临时目录；源码精确复制后做严格类型检查。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const runtime = process.env.CHUMEN_MCP_TEST_RUNTIME;
const output = process.env.CHUMEN_MCP_TEST_OUTPUT;
if (!runtime || !output) throw new Error('须显式指定隔离依赖与临时输出目录');
const ts = require(path.join(runtime, 'node_modules/typescript'));
const source = path.resolve(__dirname, '../app/internal_packages/mcp-server/lib');
fs.mkdirSync(output, { recursive: true });
for (const name of ['mcp-http-server.ts', 'mcp-client-authorization.ts']) {
  fs.copyFileSync(path.join(source, name), path.join(output, name));
}
fs.writeFileSync(path.join(output, 'mcp-tools.ts'), `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export function registerTools(_server: McpServer): void {}
export function registerResources(_server: McpServer): void {}
`);
if (!fs.existsSync(path.join(output, 'node_modules'))) fs.symlinkSync(path.join(runtime, 'node_modules'), path.join(output, 'node_modules'), 'dir');
const options = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16, strict: true, skipLibCheck: true,
  baseUrl: path.join(runtime, 'node_modules'),
  typeRoots: [path.join(runtime, 'node_modules/@types')],
  outDir: path.join(output, 'compiled'),
};
const program = ts.createProgram(['mcp-http-server.ts', 'mcp-client-authorization.ts', 'mcp-tools.ts']
  .map(name => path.join(output, name)), options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: n => n, getCurrentDirectory: () => output, getNewLine: () => '\n',
  }));
  process.exit(1);
}
program.emit();
// Runtime resolution belongs to the independent test directory, not the app.
process.env.NODE_PATH = path.join(runtime, 'node_modules');
require('node:module').Module._initPaths();
const { McpHttpServer } = require(path.join(output, 'compiled/mcp-http-server.js'));
const { issueMcpClient, findAuthorizedMcpClient, withMcpClient, currentMcpClient } =
  require(path.join(output, 'compiled/mcp-client-authorization.js'));
const a = issueMcpClient('synthetic A', ['fake-account-a'], 5);
const b = issueMcpClient('synthetic B', ['fake-account-b'], 5);
let grants = [a.grant, b.grant];
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } } });
const server = new McpHttpServer();
let port;
function begin({ token = a.token, body = init, headers = {}, target = '/mcp', end = true } = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ host: '127.0.0.1', port, path: target, method: 'POST',
      agent: false, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', ...headers } }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.once('error', reject);
    if (body) request.write(body);
    if (end) request.end();
  });
  return { request, response };
}
const send = options => begin(options).response;
(async () => {
  await server.start(0, token => findAuthorizedMcpClient(token, grants));
  port = server.httpServer.address().port;
  try {
    await test('默认拒绝无效凭据和旧共享令牌', async () => {
      assert.equal((await send({ token: 'old-shared-token' })).status, 401);
    });
    await test('外部或畸形 Host、绝对请求目标均拒绝且服务存活', async () => {
      for (const host of ['evil.example', '[invalid', 'localhost']) {
        assert.equal((await send({ headers: { Host: host } })).status, 403);
      }
      assert.equal((await send({ target: 'http://evil.example/mcp' })).status, 400);
      assert.equal((await send({ body: '{' })).status, 400);
    });
    let sid;
    await test('真实 SDK 初始化成功并建立独立会话', async () => {
      const result = await send();
      assert.equal(result.status, 200);
      sid = result.headers['mcp-session-id'];
      assert.match(sid, /^[0-9a-f-]{36}$/);
    });
    await test('其他客户端不能使用原会话', async () => {
      assert.equal((await send({ token: b.token, headers: { 'mcp-session-id': sid } })).status, 403);
    });
    await test('初始化和既有会话均限制正文；伪造原型会话拒绝', async () => {
      for (const headers of [{}, { 'mcp-session-id': sid }]) {
        assert.equal((await send({ body: 'x'.repeat(1024 * 1024 + 1), headers })).status, 413);
      }
      assert.equal((await send({ headers: { 'mcp-session-id': '__proto__' } })).status, 400);
    });
    await test('修改范围或期限后旧会话不得继承权限', async () => {
      const original = a.grant.expiresAt;
      a.grant.expiresAt += 1000;
      assert.equal((await send({ headers: { 'mcp-session-id': sid } })).status, 403);
      a.grant.expiresAt = original;
      a.grant.accountIds = ['different-fake-account'];
      assert.equal((await send({ headers: { 'mcp-session-id': sid } })).status, 403);
      a.grant.accountIds = ['fake-account-a'];
    });
    await test('正文尚未完成时撤销，完成后仍拒绝', async () => {
      const pending = begin({ body: init.slice(0, 10), end: false });
      await new Promise(resolve => setTimeout(resolve, 30));
      a.grant.enabled = false;
      pending.request.end(init.slice(10));
      assert.equal((await pending.response).status, 401);
      a.grant.enabled = true;
    });
    await test('并发异步上下文不串客户端且实时撤销', async () => {
      let active = true;
      await Promise.all([a, b].map(client => withMcpClient(client.grant, () => active, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(currentMcpClient().id, client.grant.id);
      })));
      await withMcpClient(a.grant, () => active, async () => {
        active = false;
        await Promise.resolve();
        assert.equal(currentMcpClient(), null);
      });
    });
    await test('会话达到上限拒绝新增，撤销后可重新建立', async () => {
      for (let i = server.transports.size; i < 32; i++) assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 429);
      await server.invalidateSessions();
      assert.equal(server.transports.size, 0);
      assert.equal((await send()).status, 200);
    });
    await test('慢正文在原固定 10 秒内结束', async () => {
      const started = Date.now();
      const pending = begin({ body: '{', end: false });
      assert.equal((await pending.response).status, 408);
      assert.ok(Date.now() - started < 13000);
    });
    await test('客户端中断后仍可用；停服回收未完成正文及会话', async () => {
      const abandoned = begin({ body: '{', end: false });
      const aborted = abandoned.response.catch(() => undefined);
      abandoned.request.destroy();
      await aborted;
      assert.equal((await send()).status, 200);
      const pending = begin({ body: '{', end: false });
      const ended = pending.response.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 30));
      const started = Date.now();
      await server.stop();
      await ended;
      assert.ok(Date.now() - started < 1000);
      assert.equal(server.isRunning(), false);
      assert.equal(server.transports.size, 0);
    });
  } finally { await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
