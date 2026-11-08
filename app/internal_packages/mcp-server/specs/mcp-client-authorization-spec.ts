import {
  approvedMcpClients,
  currentMcpClient,
  findAuthorizedMcpClient,
  issueMcpClient,
  withMcpClient,
} from '../lib/mcp-client-authorization';

describe('MCP 独立客户端最小授权', function () {
  it('默认无授权且拒绝任何旧的共享令牌', function () {
    expect(approvedMcpClients(undefined)).toEqual([]);
    expect(findAuthorizedMcpClient('old-shared-token', [])).toBeNull();
    expect(findAuthorizedMcpClient('mscp_' + 'a'.repeat(64), [])).toBeNull();
    expect(currentMcpClient()).toBeNull();
  });

  it('不同 Agent 获得不同令牌，仅保存哈希而不是原始令牌', function () {
    const a = issueMcpClient('Agent A', ['account-a'], 60);
    const b = issueMcpClient('Agent B', ['account-b'], null);
    expect(a.token).not.toEqual(b.token);
    expect(a.grant.tokenHash).not.toEqual(a.token);
    expect(JSON.stringify(a.grant)).not.toContain(a.token);
    expect(findAuthorizedMcpClient(a.token, [a.grant, b.grant])?.id).toBe(a.grant.id);
    expect(findAuthorizedMcpClient(b.token, [a.grant, b.grant])?.id).toBe(b.grant.id);
    expect(a.grant.accountIds).toEqual(['account-a']);
    expect(b.grant.accountIds).toEqual(['account-b']);
    expect(a.grant.accessLevel).toBe('read-only');
    expect(b.grant.expiresAt).toBeNull();
  });

  it('拒绝过期、撤销、篡改和不存在账户的 grant', function () {
    const { token, grant } = issueMcpClient('Agent A', ['account-a'], 60);
    expect(findAuthorizedMcpClient(token, [grant], grant.createdAt + 3600001)).toBeNull();
    expect(findAuthorizedMcpClient(token, [{ ...grant, enabled: false }])).toBeNull();
    expect(findAuthorizedMcpClient(token, [{ ...grant, tokenHash: '0'.repeat(64) }])).toBeNull();
    expect(findAuthorizedMcpClient(token, [{ ...grant, accountIds: [] }])).toBeNull();
    expect(findAuthorizedMcpClient(token, [{ ...grant, accessLevel: 'read-write-send' }])).toBeNull();
    expect(findAuthorizedMcpClient(token, [grant, { ...grant }])).toBeNull();
    expect(findAuthorizedMcpClient(token, [grant], grant.createdAt + 1)).toEqual(grant);
  });

  it('没有显式邮箱的授权申请必定失败', function () {
    expect(() => issueMcpClient('Agent A', [], 60)).toThrow();
    expect(() => issueMcpClient('Agent A', ['account-a'], 0)).toThrow();
    expect(() => issueMcpClient('', ['account-a'], 60)).toThrow();
    expect(() => issueMcpClient('Agent A', ['account-a'], -1)).toThrow();
  });

  it('异步会话上下文不允许撤销后继续访问', function () {
    const { grant } = issueMcpClient('Agent A', ['account-a'], null);
    let active = true;
    withMcpClient(grant, () => active, () => {
      expect(currentMcpClient()?.id).toBe(grant.id);
      active = false;
      expect(currentMcpClient()).toBeNull();
    });
    expect(currentMcpClient()).toBeNull();
  });
});
