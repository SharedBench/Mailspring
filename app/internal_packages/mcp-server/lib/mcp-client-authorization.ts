import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

// 凭据仅在人工点击授权时生成一次；本机配置只保存高熵令牌的 SHA-256 摘要。
// 当前凭据证明“持有者”而非进程身份，Chumen 原生进程认证在独立阶段接入。
export interface McpClientGrant {
  id: string;
  name: string;
  tokenHash: string;
  enabled: boolean;
  accountIds: string[];
  accessLevel: 'read-only';
  createdAt: number;
  expiresAt: number | null;
}

interface ActiveMcpClient {
  grant: McpClientGrant;
  stillAuthorized: () => boolean;
}

const context = new AsyncLocalStorage<ActiveMcpClient>();
const TOKEN_PATTERN = /^mscp_[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CLIENTS = 32;
const MAX_ACCOUNTS = 64;

export function approvedMcpClients(value: unknown): McpClientGrant[] {
  if (!Array.isArray(value) || value.length > MAX_CLIENTS) return [];
  const seen = new Set<string>();
  const result: McpClientGrant[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const client = item as Partial<McpClientGrant>;
    if (
      typeof client.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(client.id) ||
      seen.has(client.id) ||
      typeof client.name !== 'string' ||
      !client.name.trim() ||
      client.name.length > 100 ||
      typeof client.tokenHash !== 'string' ||
      !DIGEST_PATTERN.test(client.tokenHash) ||
      typeof client.enabled !== 'boolean' ||
      client.accessLevel !== 'read-only' ||
      !Array.isArray(client.accountIds) ||
      client.accountIds.length === 0 ||
      client.accountIds.length > MAX_ACCOUNTS ||
      !client.accountIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) ||
      new Set(client.accountIds).size !== client.accountIds.length ||
      typeof client.createdAt !== 'number' ||
      !Number.isSafeInteger(client.createdAt) ||
      client.createdAt <= 0 ||
      (client.expiresAt !== null &&
        (typeof client.expiresAt !== 'number' ||
          !Number.isSafeInteger(client.expiresAt) ||
          client.expiresAt <= client.createdAt))
    ) {
      return [];
    }
    seen.add(client.id);
    result.push(client as McpClientGrant);
  }
  return result;
}

export function issueMcpClient(
  name: string,
  accountIds: string[],
  durationMinutes: number | null
): { grant: McpClientGrant; token: string } {
  const safeName = name.trim();
  const uniqueAccounts = [...new Set(accountIds)];
  if (
    !safeName ||
    safeName.length > 100 ||
    uniqueAccounts.length === 0 ||
    uniqueAccounts.length > MAX_ACCOUNTS ||
    !uniqueAccounts.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) ||
    (durationMinutes !== null &&
      (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200))
  ) {
    throw new Error('无效的客户端名称、邮箱范围或授权期限');
  }
  const token = 'mscp_' + randomBytes(32).toString('hex');
  const now = Date.now();
  const grant: McpClientGrant = {
    id: randomUUID(),
    name: safeName,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    enabled: true,
    accountIds: uniqueAccounts,
    accessLevel: 'read-only',
    createdAt: now,
    expiresAt: durationMinutes === null ? null : now + durationMinutes * 60_000,
  };
  return { grant, token };
}

export function findAuthorizedMcpClient(
  bearer: string,
  stored: unknown,
  now = Date.now()
): McpClientGrant | null {
  if (typeof bearer !== 'string' || !TOKEN_PATTERN.test(bearer)) return null;
  const digest = createHash('sha256').update(bearer).digest();
  // 不将旧 core.mcp.token 视为任何客户端的授权。
  for (const client of approvedMcpClients(stored)) {
    const expected = Buffer.from(client.tokenHash, 'hex');
    if (
      timingSafeEqual(digest, expected) &&
      client.enabled &&
      (client.expiresAt === null || now < client.expiresAt)
    ) {
      return client;
    }
  }
  return null;
}

export function withMcpClient<T>(
  grant: McpClientGrant,
  stillAuthorized: () => boolean,
  fn: () => T
): T {
  return context.run({ grant, stillAuthorized }, fn);
}

// 异步结果释放前重新查询权限，避免撤销后沿用捕获的旧授权快照。
export function currentMcpClient(): McpClientGrant | null {
  const value = context.getStore();
  return value && value.stillAuthorized() ? value.grant : null;
}
