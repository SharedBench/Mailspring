import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PINNED_SYNC = '8681eae1d217d993e4d4dc7de17ae8b91fc3da49';

function replaceCount(s, from, to, expected, label) {
  const count = s.split(from).length - 1;
  if (count !== expected) throw new Error('上游源码已改变：' + label + ' (' + count + ')');
  return s.split(from).join(to);
}

export function transformStore(header, cpp) {
  header = replaceCount(header, '    MailStore();',
    '    MailStore();\n    static void configureDatabaseKeyHex(const std::string & hex);', 1, 'store header');
  cpp = replaceCount(cpp, '#include <stdexcept>',
    '#include <stdexcept>\n#include <fstream>\n#include <cctype>\n#include <cstring>', 1, 'store includes');
  const helper = [
    'namespace {',
    'std::string cipherKeyHex;',
    'SQLite::Database openCipherDatabase() {',
    '    if (cipherKeyHex.size() != 64) throw std::runtime_error("Encrypted key is required");',
    '    const std::string file = MailUtils::getEnvUTF8("CONFIG_DIR_PATH") + FS_PATH_SEP + "edgehill.db";',
    '    {',
    '        std::ifstream input(file, std::ios::binary);',
    '        if (input.good()) {',
    '            char header[16] = {};',
    '            input.read(header, sizeof(header));',
    '            if (input.gcount() == sizeof(header) &&',
    '                std::memcmp(header, "SQLite format 3\\0", sizeof(header)) == 0)',
    '                throw std::runtime_error("Plaintext mailbox requires explicit migration");',
    '        }',
    '    }',
    '    SQLite::Database result(file, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE);',
    '    result.exec("PRAGMA key = \\"x\'" + cipherKeyHex + "\'\\";");',
    '    SQLite::Statement version(result, "PRAGMA cipher_version");',
    '    if (!version.executeStep() || version.getColumn(0).getString().empty())',
    '        throw std::runtime_error("SQLCipher driver unavailable");',
    '    SQLite::Statement verify(result, "SELECT count(*) FROM sqlite_master");',
    '    if (!verify.executeStep()) throw std::runtime_error("Encrypted mailbox key invalid");',
    '    return result;',
    '}',
    '}',
    '',
    'void MailStore::configureDatabaseKeyHex(const std::string & hex) {',
    '    if (!cipherKeyHex.empty() || hex.size() != 64)',
    '        throw std::runtime_error("Invalid or repeated mailbox key");',
    '    for (unsigned char c : hex)',
    '        if (!std::isxdigit(c)) throw std::runtime_error("Invalid mailbox key encoding");',
    '    cipherKeyHex = hex;',
    '}',
    '',
  ].join('\n');
  cpp = replaceCount(cpp, '#pragma mark MailStore\n', helper + '\n#pragma mark MailStore\n', 1, 'store helper');
  cpp = replaceCount(cpp,
    '_db(MailUtils::getEnvUTF8("CONFIG_DIR_PATH") + FS_PATH_SEP + "edgehill.db", SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE),',
    '_db(openCipherDatabase()),', 1, 'store open');
  return {header, cpp};
}

export function transformMain(main) {
  main = replaceCount(main, '#include <atomic>', '#include <atomic>\n#include <algorithm>', 1, 'main includes');
  const marker = '    // handle --mode migrate early for speed\n    string mode(options[MODE].arg);';
  const keyFrame = [
    '    // 加密构建从 stdin 优先读取独立密钥帧；任何 MailStore 构造前完成。',
    '    string mode(options[MODE].arg);',
    '    if (mode != "install-check") {',
    '        cout << "\\nWaiting for Database Key:\\n";',
    '        cout.flush();',
    '        string frame;',
    '        if (!getline(cin, frame) || frame.rfind("MCPDB1:", 0) != 0) {',
    '            cerr << "Encrypted mailbox key required" << endl;',
    '            return 2;',
    '        }',
    '        try { MailStore::configureDatabaseKeyHex(frame.substr(7)); }',
    '        catch (...) {',
    '            std::fill(frame.begin(), frame.end(), char(0));',
    '            cerr << "Invalid mailbox key" << endl;',
    '            return 2;',
    '        }',
    '        std::fill(frame.begin(), frame.end(), char(0));',
    '    }',
  ].join('\n');
  return replaceCount(main, marker, keyFrame, 1, 'main startup');
}

export function transformXcode(project, prefix) {
  if (!path.isAbsolute(prefix) || /["\n\r]/.test(prefix)) throw new Error('Invalid SQLCipher prefix');
  project = replaceCount(project,
    '\t\t\t\t436489901EF2F94F007816EC /* sqlite3.c in Sources */,\n',
    '', 1, 'remove plain sqlite3 compilation');
  project = replaceCount(project,
    '"${PROJECT_DIR}/Vendor/SQLiteCpp/sqlite3",',
    '"' + prefix + '/include/sqlcipher",', 2, 'SQLCipher headers');
  project = replaceCount(project,
    'LIBRARY_SEARCH_PATHS = (\n\t\t\t\t"$(inherited)",',
    'LIBRARY_SEARCH_PATHS = (\n\t\t\t\t"$(inherited)",\n\t\t\t\t"' + prefix + '/lib",',
    2, 'SQLCipher library search');
  project = replaceCount(project,
    'OTHER_LDFLAGS = (\n',
    'OTHER_LDFLAGS = (\n\t\t\t\t"-lsqlcipher",\n', 2, 'SQLCipher linker');
  return project;
}

function main() {
  if (process.platform !== 'darwin') throw new Error('The native build preparation is macOS only');
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const upstream = path.join(root, 'mailsync');
  if (process.argv.length !== 3) throw new Error('Pass a new temporary output directory inside the repository');
  const output = path.resolve(process.argv[2]);
  if (!output.startsWith(root + path.sep) || output === upstream || fs.existsSync(output)) {
    throw new Error('Unsafe or existing output directory');
  }
  const git = (args) => execFileSync('git', ['-C', upstream, ...args], {encoding:'utf8'}).trim();
  if (git(['rev-parse','HEAD']) !== PINNED_SYNC || git(['status','--porcelain']) !== '') {
    throw new Error('Wrong or dirty upstream revision');
  }
  const prefix = process.env.SQLCIPHER_PREFIX;
  if (!prefix || !path.isAbsolute(prefix) ||
      !fs.existsSync(path.join(prefix, 'include/sqlcipher/sqlite3.h')) ||
      !['libsqlcipher.dylib','libsqlcipher.a'].some(name => fs.existsSync(path.join(prefix, 'lib',name)))) {
    throw new Error('A verified SQLCIPHER_PREFIX with library and headers is required');
  }
  const read = name => fs.readFileSync(path.join(upstream,name), 'utf8');
  const store = transformStore(read('MailSync/MailStore.hpp'), read('MailSync/MailStore.cpp'));
  const mainCpp = transformMain(read('MailSync/main.cpp'));
  const pbx = transformXcode(read('MailSync.xcodeproj/project.pbxproj'),prefix);
  fs.cpSync(upstream, output, {recursive:true, filter:p => path.basename(p) !== '.git'});
  const write = (name,s) => fs.writeFileSync(path.join(output,name),s);
  write('MailSync/MailStore.hpp',store.header);
  write('MailSync/MailStore.cpp',store.cpp);
  write('MailSync/main.cpp',mainCpp);
  write('MailSync.xcodeproj/project.pbxproj',pbx);
  console.log('Created isolated SQLCipher source snapshot: '+output);
  console.log('NOT_BUILT; NOT_SIGNED; NOT_INSTALLED; no actual mailbox was touched.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
