# Native Host 与 CLI bridge client

源码是 TypeScript ESM / NodeNext，项目构建后运行 `dist/apps/native-host/src/index.js`。主机只转发 `bridge.hello` 与 `cookies.snapshot`；不读取钥匙串，不暴露 `credentials.resolve` 或 `http.execute`。Chrome 扩展的 `connectNative` 启动主机，CLI 不能反向启动浏览器。

客户端由 [client.ts](src/client.ts) 导出：

```ts
new BrowserBridge({ home?, extensionId?, timeoutMs? })
listProfiles(): Promise<BridgeProfile[]>
getConnection(profileId: string): Promise<BridgeProfile>
snapshot(params: SnapshotParams): Promise<Snapshot>
```

`home` 默认 `INTRA_HOME`，再默认 `~/.intra`。`getConnection` 只选择明确 ID；无连接报 `PROFILE_NOT_PAIRED`，重复在线 ID 报 `PROFILE_AMBIGUOUS`。`BridgeProfile` 包含 `profileId/storeIds/extensionId/extensionVersion/protocolVersion/connectionId/socketPath/confirmed:true`，仅表示扩展 UI 已确认并握手，不能证明业务账号。CLI 负责把友好别名绑定到此 ID，多 store 时由用户明确选择。

`SnapshotParams` 维持版本 1 的 `profileId/storeId/url/cookieNames?/deadlineMs` 字段；结果仍为 `profileId/storeId/snapshotId/observedAt/cookies`。省略 cookieNames 时，返回适用于指定 URL 的全部 Cookie；显式列表必须为 1–16 个唯一合法 token，每个 1–256 字符，空数组无效。没有新增 IPC 字段。

主机接受合法 HTTP/HTTPS URL，包括 DNS 域、localhost 和 IP，拒绝 userinfo、fragment、畸形主机名及其他 scheme。所选站点范围由扩展 0.3.0 在每次快照时检查，并复核 Chrome 当前权限：自定义选定域，或用户明确勾选并授权的所有 HTTP/HTTPS 网站。过去的宽权限不能绕过本次确认的窄范围。

结果按 requestId 匹配，再校验 profile、store、URL 的 domain/path/Secure、可选名称筛选、过期时间、重复 Cookie 与分区属性。扩展始终使用 getAll({url, storeId})，不会导出整个浏览器存储。结果含秘密，只经内部受限通道传递，不可打印到 Agent stdout。授权不等于登录有效、网络发现或业务成功；用户可提供 F12 中已知的 method/URL/payload，桥本身不捕获或推断请求。CLI 继续使用精确 allowedOrigins，并按 Service/origin 隔离缓存。

协议是四字节本机字节序长度 + UTF-8 JSON，双向最大 256 KiB，拒绝截断、非法 UTF-8、错误 JSON；最多 32 个待处理快照和 16 个本地客户端，每请求最多 30 秒，握手 10 秒。Native stdin EOF/断线会清空待处理请求，关闭自己监听的 socket，并仅清理 inode 一致的自身描述文件。随机端点不会覆盖或启动时删除其他 live/stale socket。过期描述文件在发现时忽略，第一版不自动清扫。

运行目录为 `<home>/run`，home/run 必须属于当前用户且权限为 0700；socket、描述文件为 0600。描述文件与 IPC 独立，记录连接元数据，不修改既有消息契约。Unix socket 路径超过 103 字节时报明确错误，需配置更短的私有 `INTRA_HOME`。禁止符号链接作为 home/run/socket/描述文件本身。

**macOS 限制：** Node 没有可移植的 `SO_PEERCRED` 接口，本实现检查文件所有者和目录/文件权限，未验证连接对端 UID。能以同一用户执行代码的进程仍属于信任边界内；随机 profileId 也不是密码。Native Host 只接受 Chrome 传入的单个、精确 `chrome-extension://<实际ID>/` argv，并与启动器配置的 `INTRA_EXTENSION_ID` 比对；同用户进程仍可以伪造 argv。这些限制不可描述为强身份认证。

[打包生成器](../../packaging/native-host/generate.mjs) 只在显式执行时生成 staging 文件，使用绝对 Node 路径及真实扩展 ID；没有安装、注册或自动启动操作。合成测试覆盖streams/socket/process。2026-11-05已按用户授权注册宿主，并观察到真实Chrome连接和Profile配对；首轮所需Cookie匹配为空；后续0.3.0已完成第10页查询及Keychain缓存读取，见[成功记录](../../evidence/intra-e2e-risk-api-page10-success-2026-11-05.json)。该结果只覆盖记录中的操作和页面。
