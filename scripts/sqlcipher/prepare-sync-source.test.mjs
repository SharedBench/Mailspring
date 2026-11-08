import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformStore, transformMain, transformXcode, PINNED_SYNC } from './prepare-sync-source.mjs';

test('只修改预期固定版本的 MailStore 构造入口，密钥先于事务准备', () => {
  const header = 'public:\n    MailStore();\n';
  const cpp = [
    '#include <stdexcept>',
    '#pragma mark MailStore',
    '_db(MailUtils::getEnvUTF8("CONFIG_DIR_PATH") + FS_PATH_SEP + "edgehill.db", SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE),',
  ].join('\n') + '\n';
  const result = transformStore(header, cpp);
  assert.match(result.header, /configureDatabaseKeyHex/);
  assert.match(result.cpp, /_db\(openCipherDatabase\(\)\)/);
  assert.match(result.cpp, /sqlite3_key\(result.getHandle\(\)/);
  assert.match(result.cpp, /PRAGMA cipher_version/);
  assert.match(result.cpp, /Plaintext mailbox requires explicit migration/);
  assert.ok(result.cpp.indexOf('sqlite3_key(result.getHandle()') <
    result.cpp.indexOf('SELECT count(*) FROM sqlite_master'));
  assert.throws(() => transformStore(header, result.cpp), /上游源码已改变/);
  assert.equal(PINNED_SYNC, '8681eae1d217d993e4d4dc7de17ae8b91fc3da49');
});

test('迁移模式开库前先读取 stdin 密钥，且任何不兼容上游变化均拒绝', () => {
  const main = '#include <atomic>\n' +
    '    // handle --mode migrate early for speed\n    string mode(options[MODE].arg);';
  const secure = transformMain(main);
  assert.match(secure, /#include <algorithm>/);
  assert.match(secure, /MCPDB1:/);
  assert.match(secure, /configureDatabaseKeyHex/);
  assert.match(secure, /Invalid mailbox key/);
  assert.throws(() => transformMain('different upstream'), /上游源码已改变/);
});

test('macOS 构建移除普通 sqlite3.c 编译并链接 SQLCipher 两套配置', () => {
  const plain = [
    '\t\t\t\t436489901EF2F94F007816EC /* sqlite3.c in Sources */,',
    '"${PROJECT_DIR}/Vendor/SQLiteCpp/sqlite3",',
    '"${PROJECT_DIR}/Vendor/SQLiteCpp/sqlite3",',
    'LIBRARY_SEARCH_PATHS = (\n\t\t\t\t"$(inherited)",',
    'LIBRARY_SEARCH_PATHS = (\n\t\t\t\t"$(inherited)",',
    'OTHER_LDFLAGS = (',
    'OTHER_LDFLAGS = (',
  ].join('\n') + '\n';
  const secure = transformXcode(plain, '/opt/homebrew/opt/sqlcipher');
  assert.doesNotMatch(secure, /sqlite3.c in Sources/);
  assert.equal((secure.match(/"-lsqlcipher"/g) || []).length, 2);
  assert.equal((secure.match(/include\/sqlcipher/g) || []).length, 2);
  assert.throws(() => transformXcode('stale project', '/opt/homebrew/opt/sqlcipher'), /上游源码已改变/);
  assert.throws(() => transformXcode(plain, 'sqlcipher'), /Invalid SQLCipher prefix/);
});
