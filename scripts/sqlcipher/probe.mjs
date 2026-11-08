import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// 只操作本脚本新建的临时测试 profile；不接受真实用户的 CONFIG_DIR_PATH。
const binary = process.argv[2];
if (process.platform !== 'darwin' || !binary || !path.isAbsolute(binary)) {
  throw new Error('仅 macOS 运行：node scripts/sqlcipher/probe.mjs /绝对路径/mailsync-sqlcipher');
}
if (!fs.existsSync(binary)) throw new Error('SQLCipher mailsync 构建产物不存在');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailspring-sqlcipher-probe-'));
const keyHex = randomBytes(32).toString('hex');
const dbPath = path.join(directory, 'edgehill.db');

async function runMigrate() {
  const child = spawn(binary, ['--mode', 'migrate'], {
    cwd: directory,
    env: {
      ...process.env,
      CONFIG_DIR_PATH: directory,
      IDENTITY_SERVER: 'https://identity.invalid',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // 不保留原生输出内容，避免日志意外包含密钥并限制内存消耗。
  let outputBytes = 0;
  let failure = null;
  let escalation = null;
  let ended = false;
  function stop(reason) {
    if (failure || ended) return;
    failure = reason;
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
  }
  const deadline = setTimeout(() => stop('原生迁移超过 90 秒'), 90000);
  const countOutput = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) stop('原生输出超过 1 MiB');
  };
  child.stdout.on('data', countOutput);
  child.stderr.on('data', countOutput);
  child.stdin.on('error', () => stop('密钥管道写入失败'));
  const status = await new Promise((resolve, reject) => {
    child.once('error', () => {
      ended = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      reject(new Error('无法启动原生迁移程序'));
    });
    child.once('close', (code) => {
      ended = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      resolve(code);
    });
    // 只在 stdin 写密钥，不进入命令行参数、环境变量或日志。
    child.stdin.end('MCPDB1:' + keyHex + '\n');
  });
  if (failure) throw new Error(failure);
  if (status !== 0) {
    throw new Error('C++ 加密写库失败（退出码 ' + status + '，日志长度 ' +
      outputBytes + '）');
  }
}

let reader = null;
try {
  await runMigrate();
  if (!fs.existsSync(dbPath)) throw new Error('测试加密数据库不存在');
  const header = fs.readFileSync(dbPath).subarray(0, 16);
  if (header.equals(Buffer.from('SQLite format 3\0'))) {
    throw new Error('数据库仍存在普通 SQLite 明文头：加密失败');
  }

  // 必须是经过 SQLCipher 自定义编译的 better-sqlite3，不接受普通 SQLite。
  const module = await import('better-sqlite3');
  const Database = module.default;
  reader = new Database(dbPath, { readonly: true });
  reader.pragma('key = "x\'' + keyHex + '\'"');
  const version = reader.pragma('cipher_version', { simple: true });
  if (!version) throw new Error('Electron/Node 侧 SQLCipher native binding 不可用');
  const count = reader.prepare('SELECT count(*) AS n FROM sqlite_master').get().n;
  if (typeof count !== 'number') throw new Error('加密数据库读取不完整');
  reader.close();
  reader = null;

  const wrong = new Database(dbPath, { readonly: true });
  try {
    wrong.pragma('key = "x\'' + '0'.repeat(64) + '\'"');
    let refused = false;
    try {
      wrong.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('错误密钥居然能读取加密数据库');
  } finally {
    wrong.close();
  }
  console.log('REAL (local fixture): C++ SQLCipher 写库 / better-sqlite3 读库 / 错密拒绝，通过');
} finally {
  if (reader) reader.close();
  console.log('测试资料已保留：' + directory);
}
