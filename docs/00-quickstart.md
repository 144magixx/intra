# 00 · 同事上手：15 分钟装好 Intra

Intra 让 Agent 复用你本机 Chrome 里的登录态去调接口：你在浏览器里正常登录，Agent 通过 MCP 工具（或 CLI）发请求，Cookie 不会出现在对话里。本文按顺序装一遍；遇到报错先看文末的排查表。

## 0. 前提

| 需要 | 检查方法 |
|---|---|
| macOS | 目前只支持 macOS，凭据存 Keychain |
| Node.js ≥ 22 | `node -v` |
| Xcode 命令行工具 | `xcrun --find clang` 有输出；没有就运行 `xcode-select --install` |
| Chrome（要用哪个 Profile 登录就在哪个 Profile 里装扩展） | — |

## 1. 克隆并构建

```bash
git clone https://github.com/144magixx/intra.git
cd intra
./scripts/setup.sh
```

脚本会检查环境、执行 `npm ci` 和 `npm run build`，并生成扩展的 `manifest.json`。它不会改 Chrome，也不会读任何 Cookie。

## 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`，打开右上角“开发者模式”。
2. 点“加载已解压的扩展程序”，选择仓库里的 `apps/extension` 目录。
3. 记下扩展卡片上的 **ID**（32 个小写字母）。每台机器的 ID 不同，以你看到的为准。

## 3. 注册本机宿主

```bash
./scripts/setup.sh register --extension-id <你的扩展ID>
```

这一步会在 `~/.intra/native-host/` 下生成启动器，并把 `com.intra.bridge.json` 写入 Chrome 的 `NativeMessagingHosts` 目录。如果目录里已有同名文件，会先备份。启动器目录不要删除。

## 4. 授权域名并连接

1. 回到 `chrome://extensions`，**重新加载** Intra 扩展。
2. 点工具栏的 Intra 图标，在弹窗里：
   - 勾选“自定义根域或选定域名”，填入要同步登录态的域名。Cookie 一般挂在父域上，所以通常填根域，例如 `example.com`，不要只填某个子域。
   - 需要多个站点时也可以勾选“所有网站”。默认关闭，只在确实需要时打开。
   - 勾选确认框，点“授权并连接”，在 Chrome 弹出的权限框里点允许。
3. 弹窗显示状态为已连接，并出现一个 Profile ID。

扩展没有内置任何站点。每次只读取目标 URL 适用的 Cookie，不会导出整个浏览器的数据。

## 5. 配对 CLI 别名

```bash
node dist/apps/cli/src/main.js auth profiles
node dist/apps/cli/src/main.js auth pair --profile work --profile-id <auth profiles 输出的 profileId>
```

如果 `auth profiles` 列出多个 storeId，需要加上 `--store <ID>`。`work` 只是别名，可以换成别的。

## 6. 接入 Agent（MCP）

```bash
./scripts/setup.sh mcp-config --profile work
```

脚本会打印三种配置：DeepSeek Harness、Claude Code、通用 `mcpServers` JSON。把对应的一段放进你的客户端，重启或重载后会出现 `intra_request`、`intra_call`、`intra_read_artifact` 等 7 个工具，说明见 [MCP 说明](../apps/mcp/README.md)。

不接 Agent 也可以直接用 CLI：

```bash
node dist/apps/cli/src/main.js request --profile work \
  --url 'https://api.example.com/items?page=1' --method GET
```

## 7. 怎么让 Agent 帮你取数

在浏览器 F12 → Network 里找到目标请求，把**完整 URL、请求方法、载荷**和你想要的结果告诉 Agent，例如：

> https://api.example.com/list?page=1&limit=25 ，GET，统计返回里 status=0 的条数

Agent 会调用 `intra_request` 发请求，响应保存在 `~/.intra/outputs/`，再按你的要求读取和汇总。项目里的 [intra-request Skill](../skills/intra-request/SKILL.md) 写了 Agent 应遵守的规则：不猜方法和参数，信息不全就停下来问你，失败时不自动重发。

## 常见问题

| 现象 / 错误码 | 原因与处理 |
|---|---|
| `KEYCHAIN_UNAVAILABLE` | 没装 Xcode 命令行工具（`xcode-select --install`），或者 Keychain 弹窗被拒绝了。第一次读写 Keychain 会弹窗，选“始终允许” |
| `BRIDGE_UNAVAILABLE` | 扩展没连接：重载扩展，再在弹窗里点“授权并连接”。Chrome 或扩展重启后都需要重新连接 |
| `PROFILE_NOT_PAIRED` | 还没执行 `auth pair`，或者扩展点了“生成新 Profile ID”。重新执行第 5 步 |
| `FORBIDDEN`（快照阶段） | 目标域名不在授权范围内。在弹窗里改成正确的根域，重新授权 |
| `COOKIE_NOT_FOUND` | 这个 Chrome Profile 没登录目标站点，或者授权的是子域而 Cookie 挂在父域。先在浏览器里登录，再改成授权根域 |
| `LOGIN_REQUIRED` / 401 / 跳到登录页 | 浏览器里的登录已过期，重新登录后再试 |
| `REQUEST_OUTCOME_UNKNOWN` | 请求可能已经执行，**不要直接重发**，先去系统里确认结果 |
| 扩展 ID 变了 | 重新执行第 3 步注册宿主 |

更新代码：`git pull && npm ci && npm run build`，然后在 `chrome://extensions` 重载扩展，再重新连接一次。

## 安全提示

- 不要把 `~/.intra` 目录、`outputs/` 里的响应文件或 HAR、cURL 提交到任何仓库。响应里可能有业务敏感数据。
- 宿主信任同一个 macOS 用户下的进程，不要在共享账户上使用。
- 授权范围越小越好，“所有网站”只在确实需要时打开。
