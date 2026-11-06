# Chrome MV3 扩展

[manifest 模板](manifest.template.json) 配套 [模块 worker](background.js)、[桥控制器](bridge.js) 和 [确认页面](popup.html)。运行代码是自包含 JavaScript；主机与客户端独立按共享契约复核消息。

只有显式运行下列命令才创建可加载的扩展清单（已存在则拒绝覆盖）：

```sh
node apps/extension/build.mjs
```

生成后由用户在 Chrome 开发者模式加载本目录，取得实际 extension ID，并参考 [宿主打包说明](../../packaging/native-host/README.md)。构建不会加载扩展或注册宿主。

## 选择授权范围

0.3.2 的必需权限只有 `cookies`、`nativeMessaging`、`storage`；`http://*/*` 与 `https://*/*` 仅在 `optional_host_permissions` 中声明。声明可申请的范围不会自动授予网站访问权。用户在 popup 中选择范围、确认 Profile，再点击“授权并连接”，Chrome 才会收到权限申请。

- 0.3.2 起没有内置站点预设，弹窗里不出现任何具体公司域名；所有网站都通过自定义域或所有网站入口授权。旧版本保存的预设选择 ID 会被拒绝，需要重新选择自定义域并确认。
- 自定义：明确输入根域或选定域名，例如 example.com 或 api.example.com。只接受 DNS 域名（ASCII 或 punycode）和 localhost，不接受 URL、IP、userinfo、路径、query、fragment、端口或通配符。不会从 api.example.com 推断 example.com；如果 Cookie 属于 .example.com，需要用户明确选择 example.com。
- “所有网站（HTTP/HTTPS）”：单独勾选，默认关闭。明确选择并批准 Chrome 权限后，可为任意有效 HTTP/HTTPS 主机请求快照，包括 localhost 与有效 IP；不开放 file、chrome 或其他 scheme。

`permissionOriginsFor(selections)` 接受 `all`、`domain:example.com` 两类选择 ID。每个显式域申请 `http://*.example.com/*` 和 `https://*.example.com/*`，Chrome 的模式包含根域及子域。“所有网站”申请两条全 HTTP/HTTPS 模式，不使用 `<all_urls>`。

同时申请两个 scheme 是为了 Chrome 对 Cookie 自身域名和 Secure 属性的权限检查：非 Secure .example.com Cookie 对应 http://example.com/，Secure Cookie 对应 https://example.com/。即使 getAll 传入子域 URL，只授予该子域也可能读不到父域共享 Cookie。依据见 [Chromium Cookie API 源码](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/api/cookies/cookies_helpers.cc)。

worker 在确认时检查权限，生成或复用 storage.local 中的随机 UUID profileId，记录选定范围，再调用 connectNative 和 bridge.hello。每个快照都检查本次确认的范围以及对应 Chrome 权限。即使之前批准过所有网站，本次只选一个自定义域也不能读取其他域。权限撤销后在读取 Cookie 前拒绝。状态和持久化配对信息不包含 Cookie 值。

不会自动授权或重连。Chrome、worker 或端口重启后需要重新确认。CLI 将 profileId 绑定到友好别名，storeId 不是 Profile。复制 Profile 后出现重复 ID 时，先断开副本，再用“生成新 Profile ID”重新配对。

## 快照与凭据边界

每次只调用 `chrome.cookies.getAll({ url, storeId })`，URL 必须是调用方请求的具体 URL，从不省略 URL 或读取整仓 Cookie。省略 `cookieNames` 表示取适用于该 URL 的全部 Cookie；显式列表只保留指定名称，必须包含 1–16 个唯一合法 token，每个长度为 1–256。空数组无效。HTTP 请求只接受非 Secure Cookie，Cookie domain、path、store 与过期时间仍被验证。

请求还检查 profile/store 与 deadline；选中 Cookie 含 partitionKey 时失败关闭，不转成普通 Cookie。无痕模式禁止。双向帧限 256 KiB，最多 32 个并发快照；大快照明确失败，不截断数组。快照含秘密，只走内部桥接通道，不作为 Agent 输出，也不在 popup 展示或导出。

授权范围表示可以同步哪些 URL 的登录态，不保证网站已登录或业务调用成功。用户可以从 F12 提供 method、URL、payload，由 Agent 整理后调用工具；扩展不会观察网络、捕获请求、解析或猜测接口。CLI 的 Service 继续分别限制精确 allowedOrigins；各 Service/origin 的缓存保持隔离。

## 更新与验证

已有加载清单应直接更新到与 [模板](manifest.template.json) 一致，不重新运行拒绝覆盖的生成器。用户自行在 chrome://extensions 重载现有扩展，确认版本 0.3.2，再打开 popup 选择范围并批准权限。代码更新不会自动重载或连接。

合成测试覆盖无预设、自定义域、显式全站选择，旧全站授权下的单站隔离，权限拒绝与撤销，省略名称和精确筛选，URL/store/domain/path/Secure/分区保护以及帧与协议限制。测试没有读取真实 Chrome Cookie、Keychain 或发送业务请求。2026-11-05已使用0.3.0完成Risk API第10页真实查询与独立进程Keychain缓存读取，见[成功记录](../../evidence/intra-e2e-risk-api-page10-success-2026-11-05.json)。0.3.1移除两个示例预设，0.3.2移除最后一个公司域预设；其他站点和通用URL模式不因该次成功而视为已验收。
