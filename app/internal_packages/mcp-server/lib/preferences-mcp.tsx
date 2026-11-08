import React from 'react';
import { clipboard } from 'electron';
import { localized } from 'mailspring-exports';
import { Switch } from 'mailspring-component-kit';
import McpServerManager from './mcp-server-manager';
import PreferencesMcpAccounts from './preferences-mcp-accounts';
import PreferencesMcpAudit from './preferences-mcp-audit';
import {
  approvedMcpClients,
  issueMcpClient,
  McpClientGrant,
} from './mcp-client-authorization';

type AccountSettings = {
  [accountId: string]: { enabled: boolean; excludedFolderIds?: string[] };
};

interface State {
  enabled: boolean;
  port: number;
  enabledAccounts: AccountSettings;
  approvedClients: McpClientGrant[];
  running: boolean;
  error: string | null;
  clientName: string;
  duration: '60' | '1440' | 'permanent';
  notice: string;
}

export default class PreferencesMcp extends React.Component<Record<string, never>, State> {
  private _unsubscribe: (() => void) | null = null;
  private _portChangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Record<string, never>) {
    super(props);
    this.state = {
      ...this._snapshot(),
      clientName: '',
      duration: '60',
      notice: '',
    };
  }

  componentDidMount() {
    this._unsubscribe = McpServerManager.listen(() => {
      this.setState(this._snapshot());
    });
  }

  componentWillUnmount() {
    this._unsubscribe?.();
    if (this._portChangeTimer) clearTimeout(this._portChangeTimer);
  }

  private _snapshot() {
    return {
      enabled: AppEnv.config.get('core.mcp.enabled') || false,
      port: AppEnv.config.get('core.mcp.port') || 2587,
      enabledAccounts: AppEnv.config.get('core.mcp.enabledAccounts') || {},
      approvedClients: approvedMcpClients(AppEnv.config.get('core.mcp.approvedClients')),
      running: McpServerManager.isRunning(),
      error: McpServerManager.getError(),
    };
  }

  private _setEnabled = () => {
    AppEnv.config.set('core.mcp.enabled', !this.state.enabled);
    this.setState(this._snapshot());
  };

  private _setAccounts = (enabledAccounts: AccountSettings) => {
    AppEnv.config.set('core.mcp.enabledAccounts', enabledAccounts);
    this.setState({ enabledAccounts });
  };

  private _setPort = (event: React.ChangeEvent<HTMLInputElement>) => {
    const port = Number(event.target.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    this.setState({ port });
    if (this._portChangeTimer) clearTimeout(this._portChangeTimer);
    this._portChangeTimer = setTimeout(() => {
      AppEnv.config.set('core.mcp.port', port);
    }, 500);
  };

  private _issueClient = () => {
    const accountIds = Object.keys(this.state.enabledAccounts).filter(
      (id) => this.state.enabledAccounts[id]?.enabled
    );
    if (!accountIds.length) {
      this.setState({ notice: '请先明确勾选至少一个允许访问的邮箱，默认不授权任何邮箱。' });
      return;
    }
    if (this.state.approvedClients.length >= 32) {
      this.setState({ notice: '客户端授权已达上限，请先撤销不再使用的授权。' });
      return;
    }
    try {
      const durationMinutes = this.state.duration === 'permanent' ? null : Number(this.state.duration);
      const { grant, token } = issueMcpClient(this.state.clientName, accountIds, durationMinutes);
      // 不保存原始令牌。用户明确点击“创建并复制”时才写入一次剪贴板。
      clipboard.writeText(token);
      AppEnv.config.set('core.mcp.approvedClients', [...this.state.approvedClients, grant]);
      this.setState({
        approvedClients: [...this.state.approvedClients, grant],
        clientName: '',
        notice:
          '只读访问令牌已复制到剪贴板（仅此一次）。请手动配置到该客户端；不要分享或写进仓库，配置后清空剪贴板。',
      });
    } catch (error) {
      this.setState({ notice: (error as Error).message || '创建授权失败' });
    }
  };

  private _revokeClient = (id: string) => {
    const next = this.state.approvedClients.filter((client) => client.id !== id);
    AppEnv.config.set('core.mcp.approvedClients', next);
    this.setState({ approvedClients: next, notice: '授权已撤销；该客户端原有令牌与会话立即失效。' });
  };

  render() {
    const {
      enabled,
      port,
      enabledAccounts,
      approvedClients,
      running,
      error,
      clientName,
      duration,
      notice,
    } = this.state;

    return (
      <div className="container-mcp">
        <section>
          <h6>{localized('MCP Server')}</h6>
          <p className="mcp-description">
            邮件 MCP 默认没有授权。启用服务并不授予读取权；每个客户端必须单独创建授权并明确选择邮箱。
          </p>
          <div className="mcp-toggle-row">
            <Switch checked={enabled} onChange={this._setEnabled} label={localized('Enable MCP Server')} />
            <span className="mcp-toggle-label">{localized('Enable MCP Server')}</span>
            {enabled && (
              <span className={`mcp-status ${running ? 'running' : 'stopped'}`}>
                {running ? localized('Running') : localized('Stopped')}
              </span>
            )}
          </div>
          {error && <div className="mcp-error">{error}</div>}
        </section>

        <section>
          <h6>连接与授权</h6>
          <p className="mcp-description">
            旧的通用 Bearer Token 和 Claude/Codex 一键接入已禁用。请为每个 Agent 创建独立只读授权；
            令牌仅在创建时复制一次，配置中只保留哈希，不自动授予附件、发送、删除和写入能力。
            当前是 Mailspring 本机人工授权，Chumen 原生审批与进程身份认证需另行接入。
          </p>
          <div className="mcp-field-row">
            <label>{localized('Port')}</label>
            <input type="number" value={port} min={1} max={65535} onChange={this._setPort} className="mcp-port-input" />
          </div>
          <div className="mcp-field-row">
            <label>{localized('Endpoint')}</label>
            <code className="mcp-endpoint">http://127.0.0.1:{port}/mcp</code>
          </div>
        </section>

        <section>
          <h6>允许访问的邮箱</h6>
          <p className="mcp-description">
            所有邮箱默认关闭。先勾选允许访问的邮箱，然后为指定 Agent 签发只能访问这些邮箱的独立令牌。
          </p>
          <PreferencesMcpAccounts enabledAccounts={enabledAccounts} onChange={this._setAccounts} />
        </section>

        <section>
          <h6>独立客户端授权（仅只读）</h6>
          <div className="mcp-field-row">
            <label>客户端名称</label>
            <input
              type="text"
              value={clientName}
              maxLength={100}
              placeholder="例如：我的 Codex"
              onChange={(event) => this.setState({ clientName: event.target.value })}
            />
          </div>
          <div className="mcp-field-row">
            <label>授权期限</label>
            <select
              value={duration}
              onChange={(event) =>
                this.setState({ duration: event.target.value as State['duration'] })
              }
            >
              <option value="60">1 小时</option>
              <option value="1440">1 天</option>
              <option value="permanent">永久（随时可撤销）</option>
            </select>
          </div>
          <button className="btn" onClick={this._issueClient}>
            创建并复制独立只读令牌
          </button>
          {notice && <p className="mcp-description" role="status">{notice}</p>}
          <p className="mcp-description">
            HTTP 客户端需要设置 Authorization: Bearer &lt;刚刚复制的令牌&gt;。
            此令牌代表持有者身份，不应交给其他 Agent；本机 HTTP 尚未升级到加密传输。
          </p>

          {approvedClients.length === 0 ? (
            <p className="mcp-description">当前没有获授权的客户端，所有 MCP 请求均被拒绝。</p>
          ) : (
            <div className="mcp-accounts-list">
              {approvedClients.map((client) => (
                <div className="mcp-account-item" key={client.id}>
                  <div className="mcp-account-header">
                    <span className="mcp-account-name">{client.name}</span>
                    <span className="mcp-account-email">
                      只读 · {client.accountIds.length} 个邮箱 ·{' '}
                      {client.expiresAt === null
                        ? '永久'
                        : new Date(client.expiresAt).toLocaleString()}
                    </span>
                    <button className="btn btn-small" onClick={() => this._revokeClient(client.id)}>
                      撤销
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <PreferencesMcpAudit />
        </section>
      </div>
    );
  }
}
