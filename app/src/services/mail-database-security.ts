// SQLCipher 最小接入：从 Electron macOS 安全存储读取已包装的数据库密钥。
// 目前只为开发隔离验证提供只读启动路径；不在应用里自动创建/迁移真实用户数据库。
export function databaseEncryptionRequested(): boolean {
  return AppEnv.config.get('core.databaseSecurity.enabled') === true;
}

export async function databaseEncryptionKeyHex(): Promise<string | null> {
  if (!databaseEncryptionRequested()) return null;
  if (process.platform !== 'darwin') {
    throw new Error('SQLCipher 模式目前只允许在 macOS 上验证');
  }
  // Chumen 原生审批尚未接入；生产模式不得误以为 Keychain 等于应用授权。
  if (!AppEnv.inDevMode() || process.env.MAILSPRING_SQLCIPHER_PROBE !== '1') {
    throw new Error('SQLCipher 仅允许隔离开发验证，正式授权入口尚未验收');
  }
  const wrapped = AppEnv.config.get('core.databaseSecurity.wrappedKey');
  if (typeof wrapped !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapped) ||
      wrapped.length > 4096) {
    throw new Error('SQLCipher 数据库密钥未通过安全方式准备');
  }
  const { safeStorage } = require('@electron/remote');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('macOS 安全存储不可用，拒绝打开数据库');
  }
  let decrypted: { result: string; shouldReEncrypt?: boolean };
  try {
    decrypted = await safeStorage.decryptStringAsync(Buffer.from(wrapped, 'base64'));
  } catch {
    throw new Error('无法从安全存储读取 SQLCipher 数据库密钥');
  }
  if (!decrypted || typeof decrypted.result !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decrypted.result)) {
    throw new Error('SQLCipher 数据库密钥格式无效');
  }
  return decrypted.result;
}
