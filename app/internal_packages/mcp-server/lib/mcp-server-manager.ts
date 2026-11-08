import MailspringStore from 'mailspring-store';
import { McpHttpServer } from './mcp-http-server';
import { findAuthorizedMcpClient } from './mcp-client-authorization';

class McpServerManagerStore extends MailspringStore {
  private _server: McpHttpServer = new McpHttpServer();
  private _error: string | null = null;
  private _configDisposable: { dispose: () => void } | null = null;
  private _lastSnapshot: { enabled: boolean; port: number } | null = null;

  activate() {
    this._configDisposable = AppEnv.config.onDidChange('core.mcp', () => {
      this._reconcileServerState();
    });
    this._reconcileServerState();
  }

  deactivate() {
    if (this._configDisposable) {
      this._configDisposable.dispose();
      this._configDisposable = null;
    }
    this._server.stop();
  }

  isRunning(): boolean {
    return this._server.isRunning();
  }

  getError(): string | null {
    return this._error;
  }

  private async _reconcileServerState() {
    const enabled = AppEnv.config.get('core.mcp.enabled') || false;
    const port = AppEnv.config.get('core.mcp.port') || 2587;

    // 配置发生变化会清理原会话；只在监听开关或端口变化时重绑 TCP。
    // MCP 身份与权限始终按最新授权列表重新读取。
    const snapshot = { enabled, port };
    const changed =
      !this._lastSnapshot ||
      this._lastSnapshot.enabled !== snapshot.enabled ||
      this._lastSnapshot.port !== snapshot.port;
    this._lastSnapshot = snapshot;

    if (!changed) {
      // 包括客户端撤销、账号范围变化：终止先前创建的 MCP 会话。
      await this._server.invalidateSessions();
      return;
    }

    if (!enabled) {
      if (this._server.isRunning()) {
        await this._server.stop();
        this._error = null;
        this.trigger();
      }
      return;
    }

    // enabled or port changed — restart to (re)bind the listener.
    try {
      await this._server.stop();
      await this._server.start(port, (token) =>
        findAuthorizedMcpClient(token, AppEnv.config.get('core.mcp.approvedClients'))
      );
      this._error = null;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EADDRINUSE') {
        this._error = `Port ${port} is already in use. Choose a different port.`;
      } else {
        this._error = nodeErr.message || 'Unknown error starting MCP server';
      }
      console.error('[MCP Server]', this._error);
    }
    this.trigger();
  }
}

export default new McpServerManagerStore();
