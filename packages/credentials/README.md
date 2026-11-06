# Credentials（开发版）

实现 Profile 元数据、异步秘密存储、按服务与 origin 隔离的 Cookie 会话，以及有界跨进程刷新锁。入口见 [src/index.ts](src/index.ts)，合成测试见 [credentials.test.ts](../../tests/credentials.test.ts)。不依赖浏览器自动化或第三方登录管理器。

- `Credentials({ store, home })`：`pair` / `profile` 保存和读取公开配对元数据；`previewSnapshot` 生成临时、账号未验证的会话；`saveSnapshot` 完整校验后提交；`resolve` 为本进程创建新引用。
- `pair({ alias, profileId, storeId, extensionId, accountId? })` 只记录配对元数据。调用方须先完成浏览器桥用户确认；Profile ID、扩展 ID、预期账号均不能充当认证证明。重复别名和 Profile ID 拒绝覆盖。
- `saveSnapshot(alias, service, snapshot, accountId?, requestedURL?)` 的账号必须来自 Core 已成功执行的身份探针。已绑定账号拒绝更换或降级为未验证。`previewSnapshot(alias, service, snapshot, requestedURL?)` 不持久化、不自动绑定账号。
- `requestedURL` 默认是 `service.baseUrl`。同步路径 Cookie 时必须传入真实快照请求 URL，例如 `/api/items`，使路径属性按正确上下文校验。
- `service.auth.cookieNames` 可省略：接受浏览器 `getAll({ url, storeId })` 返回的、适用于目标 URL 的全部合法 Cookie，仍逐条检查域、路径、Secure、过期时间等属性。必须至少有一个当前适用 Cookie；空快照或全部过期返回 `COOKIE_NOT_FOUND`，不能据此宣称已登录。显式非空名称列表则是严格白名单，且每个名称都必须有适用 Cookie；`[]` 不合法。
- 省略名称时，`resolve` 只复用同一 origin、同一 pathname 的完整无名称过滤快照；query 变化不影响匹配。根路径快照无法证明深层路径的 Cookie 完整。更换 pathname 返回 `COOKIE_NOT_FOUND`，由 Core 在浏览器在线且扩展已连接时同步新路径。旧版或指定名称的缓存也不能充当完整 URL 快照；指定名称模式仍可在已有必需 Cookie 全部适用时跨路径使用缓存。
- 快照不会跨站点合并，也不会读取或拼接整个浏览器 Cookie 仓库。每个 Profile/Store/服务/origin 的 active 指针只发布最新完整快照，不累积多个路径的 Cookie。
- `CredentialSession` 暴露 `credentialRef`、公开 `metadata`、内容指纹 `generation`、`cookieHeader(url)` 和 `acceptSetCookie(url, headers)`。引用没有跨进程查询接口；JSON 序列化和对象检查不含 Cookie 值。
- `withRefreshLock(alias, service, callback, { timeoutMs?, pollMs? })` 使用私有目录中的排他锁，默认等待至多 5 秒，上限 30 秒。调用方在锁内重新读取 generation，避免重复刷新。`REFRESH_LOCK_TIMEOUT` 明确表示等待超时。

Cookie 匹配使用 tough-cookie 6，保留 hostOnly/domain/path/expiry/Secure/HttpOnly/SameSite 属性。Secure 不能用于 HTTP，包含 localhost；jar 明确设置 `allowSecureOnLocal: false`。每个会话只接受其原始精确 origin，跨 origin 要重新 resolve；省略名称时，`cookieHeader` 与 `acceptSetCookie` 还要求原始 pathname，相同路径的 query 可以变化。服务 allowedOrigins 不能因为 Cookie domain 较宽而扩大。分区 Cookie 拒绝使用。省略名称时，Set-Cookie 可在当前 URL 会话内接收任意合法名称；指定名称时只接收白名单内名称。更新先在副本完整校验，再原子替换当前会话，不持久化到 Keychain、不反写 Chrome，不修改其他调用的会话。公开 metadata 只列当前适用 Cookie 名称和状态，不含值。

`CredentialStore` 为 `get(key): Promise<string|null>`、`set(key,value): Promise<void>`、`delete(key): Promise<void>`。`MemorySecretStore` 仅用于合成测试，不是 CLI 的生产存储选项。生产使用 `MacKeychainStore`，不提供加密文件或明文文件后备。

[Objective-C helper](native/keychain.m) 通过 Security.framework 的 SecItem API 访问 Keychain。调用方通过 JSON stdin 传值，stdout 由 Node 子进程管道捕获，stderr 被吸收；参数、环境、日志和普通文件不含凭据值。构造 store 或导入模块不会运行原生 helper；第一次实际 get/set/delete 才按需编译并调用。`buildKeychainHelper({ home? })` 可显式只编译，不执行 helper，也不读写 Keychain；使用系统 Clang 及 Foundation/Security frameworks，需要 macOS Xcode Command Line Tools。可测试注入的 runner，不需要安装或注册。

公开 Profile 文件使用 0700 目录和 0600 原子替换文件，拒绝符号链接文件。秘密快照按 Profile/Store/服务/origin/账号隔离，用不可变快照和单次原子 active 指针发布。即使 native helper 在提交后丢失回复，也不会删除可能已发布的完整快照；错误返回不承诺该次写入完全没有生效，后续 resolve 可读取一致的旧版或新版。

当前限制：

- **没有真实 Keychain 读写、访问权限弹窗、硬件或浏览器集成验收。** 合成测试验证 Cookie 行为、账户隔离、原子发布失败、锁和子进程 redaction；编译通过也不等于真实 Keychain 验收。2026-11-05 在本机使用现有 Clang 对 Objective-C helper 仅编译验证成功，产物 54,024 字节、权限 0700，随后删除临时构建目录；未执行 helper、未读写 Keychain，也未安装或修改系统工具链。
- 旧不可变快照与提交失败留下的未引用快照目前保留在 CredentialStore 中，**没有自动 GC、历史清理或撤销命令**。这样可保证并发读者读取旧指针后仍能取得完整快照；生产长期使用前需补充安全的历史保留与回收策略。它们从不写入公开元数据文件。
- 异常退出留下的锁不会自动抢占或删除。等待有界超时，需要确认没有活跃持有者后人工处理残留锁；锁只含 PID 和随机所有权标记。
- 身份探针、浏览器桥校验、刷新重试决策由 Core/桥负责。浏览器关闭后缓存只能表示 last-observed；本模块不能签发或续期登录。
- SameSite 浏览器顶层上下文、CHIPS、HTTP 更新跨调用持久化尚未支持。快照按请求 URL 获取；省略名称时更换 pathname 需新快照，即使旧缓存中有根路径 Cookie，也不能离线证明新路径已完整同步。指定名称时仍要求所有必需 Cookie 适用。

设计约束见 [凭据文档](../../docs/06-credentials.md)。
