import { localized, PreferencesUIStore } from 'mailspring-exports';
import McpServerManager from './mcp-server-manager';

let preferencesTab: any = null;

export function activate() {
  if (AppEnv.isMainWindow()) {
    McpServerManager.activate();
    // 旧共享令牌的自动注册已停用。独立客户端令牌必须经用户明确授权。
  }

  preferencesTab = new PreferencesUIStore.TabItem({
    tabId: 'MCP',
    displayName: localized('MCP Server'),
    componentClassFn: () => require('./preferences-mcp').default,
    order: 10,
  });
  PreferencesUIStore.registerPreferencesTab(preferencesTab);
}

export function deactivate() {
  McpServerManager.deactivate();
  if (preferencesTab) {
    PreferencesUIStore.unregisterPreferencesTab(preferencesTab.sectionId);
    preferencesTab = null;
  }
}

export function serialize() {
  return {};
}
