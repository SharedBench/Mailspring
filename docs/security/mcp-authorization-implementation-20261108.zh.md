# MCP 独立授权 MVP — 源码实施及验证边界

日期：2026-11-08。任务目标：[V3 最小范围](core-database-and-mcp-authorization-mvp-20261108.zh.md)。关联 Draft [PR #1](https://github.com/SharedBench/Mailspring/pull/1) 和跨仓 [Chumen Issue #66](https://github.com/buildHelpers/Chumen/issues/66)。

## 1. 本次已提交的代码

| 文件 | 已实现的目标 |
| --- | --- |
| `app/internal_packages/mcp-server/lib/mcp-client-authorization.ts` | 每客户端独立 CSPRNG 256-bit 令牌、只在签发时交付一次、配置只存 SHA-256 摘要、账号集合、只读、到期/永久与撤销校验；异步上下文检查 |
| `mcp-http-server.ts` | 不再接受旧的 `core.mcp.token`，仅逐客户端授权的 Bearer；会话绑定客户端 ID 和凭据摘要，跨客户端共用 session 拒绝；每次请求动态核对最新授权 |
| `mcp-server-manager.ts` | 始终从当前授权列表认证；调整邮箱范围、撤销或变更配置时清理已建会话 |
| `mcp-access-control.ts` | **零客户端/零明确账号→拒绝**；全局 `read-write-send` 无权扩展客户端仅只读授权；邮箱范围是客户端绑定范围与用户明确选中邮箱的交集 |
| `mcp-tools.ts` | 工具执行前后复核授权；首批禁用 `get_attachment` 和 `resources/read` 原始附件能力，防止只读令牌读取任意磁盘文件 |
| `preferences-mcp.tsx` 和 `preferences-mcp-accounts.tsx` | 默认无邮箱授权；设置页显示独立客户端、人审签发并复制一次、期限（1h / 1d / 永久）、撤销；旧快捷安装按钮与共享 Bearer 展示取消 |
| `main.ts`、`mcp-stdio-bridge.js` | 不再自动安装、刷新或尝试复用旧 Claude Desktop stdio 桥的共用 token；旧桥返回明确错误，而不是自动降级 |
| `specs/mcp-client-authorization-spec.ts` 等 | 新增/替换负例：无 token、旧 token、哈希不等于 token、过期/撤销、零账号、跨客户端 session、禁用附件、历史桥拒绝 |

**功能边界**：当前是 **Mailspring 页面人工签发的 bearer 持有者授权**，不是 Chumen 原生弹窗/可信进程身份批准。账号范围固定于令牌签发时，后续取消账号会继续缩小权限，不随全局新增账号扩权。授权令牌丢失只能撤销重签；永久只是不自动过期，可随时撤销。旧 Claude/ChatGPT/Claude Code 的自动配置必须由用户自行移除或重新配置，程序不擅自修改用户已存在的客户端配置。

## 2. 当前关键未完成项：核心数据库加密

- **BLOCKED**：`edgehill.db` 当前依然是原来的普通 SQLite。Mailspring 仓库仅引用 [Foundry376/Mailspring-Sync 固定子模块](https://github.com/Foundry376/Mailspring-Sync/tree/8681eae1d217d993e4d4dc7de17ae8b91fc3da49)，当前账户没有该上游写权限；Electron `better-sqlite3` 与 C++ `SQLiteCpp`/sqlite3 也都尚未替换为兼容的 SQLCipher 双端。
- 未提供假测试库的 SQLCipher 读写、WAL/SHM、同步、错密和崩溃恢复的 Mac 实测证据，故不启用加密模式，也不试探或迁移真实邮箱。**数据库加密实际完成度 0，核心需求不算已交付。**
- Mailspring Issues 当前被禁用（实际创建返回 HTTP 410）；因需要 Issue 追踪，将本项目阻塞记录在 Chumen Issue #66，后续可在启用本仓 Issues 后迁回。

## 3. 验证状态与安全限制

| 事项 | 状态 / 本次事实 |
| --- | --- |
| GitHub 精确 PR 文件与提交 | `REAL`：源码已写入独立分支；PR #1 包含 MCP 变更与测试文件 |
| 静态代码对照 | `SOURCE_REVIEW`：旧共享令牌的 server 校验、auto setup 和默认全部账号逻辑已替换 |
| 新增 Jasmine 测试文件 | `WRITTEN / NOT_RUN`：编写不等于执行，未声称全部通过 |
| `npm run typecheck`、Jasmine、Playwright | `NOT_RUN`：本会话无该仓完整已安装依赖的本地 checkout；也未触发 CI |
| 真实 Mailspring/Electron/macOS、Chumen 弹窗与 Keychain | `NOT_RUN` |
| 完整 SQLCipher 数据库双端加密 | `BLOCKED / NOT_IMPLEMENTED` |
| 附件、配置、缓存加密、本机 HTTP 传输加密、强同 UID 进程隔离 | `OUT_OF_SCOPE`；禁止宣称“所有数据和通信都加密” |

### 待实际运行的最小测试命令（不会自动运行）

```sh
npm run typecheck
npm test -- --spec-file-pattern='mcp-(client-authorization|http-server|stdio-bridge)'
```

在 macOS 临时 profile/假账号下还需验证：配置页创建只读令牌 → 仅指定账号可读 → 另一个客户端无权使用其 session → 旧共享 bearer 401 → 取消邮箱/撤销 grant 即时拒绝 → 过期/永久/锁定对应行为。每项须记录 `REAL / FAILED / BLOCKED`，不得将隔离 mocks 冒充真实客户端/授权验收。

## 4. 遗留风险与下一步

1. **优先解决 DB P0**：确定一个可写、可签名、可重建的 C++ Mailspring-Sync 加密引擎来源，固定 SQLCipher 版本，再连接 Electron Reader 和密钥接口；不要加无用的“加密已开启”开关。
2. **MCP 身份还有限制**：bearer 被窃取时，可由任意持有者复用；普通 Mailspring 配置本身不是 Chumen 受信任、抗同 UID 篡改的授权库，未来需 Chumen 原生审批 + Keychain/签名约束。
3. **旧桥不兼容**：为阻断旧共享令牌，历史 stdio 自动接入被有意停止；需另行实现按客户端秘密存储的安全 stdio 配对，不能回退共享 token。
4. **性能和互操作性**：尚未跑完整 NPM 构建，MCP SDK 事件上下文及撤权中异步请求的跨进程边界必须在真实 Mac 测试中验证；验收前保持 PR Draft，不部署/合主。
5. **资料暴露**：本地 MCP HTTP 仍是未加密回环通道；只有高熵凭据和会话隔离，不宣称链路加密或 OS 沙箱。
