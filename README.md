# Intra：让 Agent 复用浏览器登录态调用接口

> **当前状态：开发版运行时，扩展0.3.2。** 支持按域授权或用户显式授权全部HTTP/HTTPS网站、直接URL请求、JSON/原始正文文件和本地结果输出。合成测试与真实环境边界见[开发版状态](docs/11-runtime-status.md)；Risk API第10页已完成真实查询，返回10条、总数589，详见[成功记录](evidence/intra-e2e-risk-api-page10-success-2026-11-05.json)。

用户提供F12截图或复制的完整URL、请求方法、载荷以及查询意图，由Agent按[调用Skill](skills/intra-request/SKILL.md)归一化明确入参；工具只校验并执行请求。工具不识别截图、不自动发现接口、不推断业务参数，也不读取整份浏览器Cookie仓库。

Intra 在本机同步经授权、适用于目标URL的Cookie，由CLI直接执行HTTP。Cookie值只在受限桥接通道、Keychain和内部进程中使用，Agent获得状态、摘要及结果文件。已有完整缓存时直接复用；自动URL模式换pathname需新的URL快照，query换页可复用缓存。

## 快速开始

第一次使用请按 [同事上手](docs/00-quickstart.md) 操作：`./scripts/setup.sh` 负责构建，`./scripts/setup.sh register` 注册浏览器宿主，`./scripts/setup.sh mcp-config` 打印 MCP 配置。仅支持 macOS + Chrome，需要 Node.js ≥ 22 和 Xcode 命令行工具。许可证见 [LICENSE](LICENSE)（MIT）。

## 本地构建与检查

需要 Node.js 22 或以上。运行时源码使用 TypeScript / ESM：

```bash
npm ci
npm run build
npm test
npm run check:docs
node dist/apps/cli/src/main.js --help
node dist/apps/cli/src/main.js doctor
```

`npm test` 使用合成 Cookie、本地模拟 HTTP 服务和临时目录。`npm run check:docs` 仍可单独运行，不需要安装依赖，只检查文档、Schema 子集和样例。构建和测试不会安装扩展、注册宿主或访问真实业务。

命令统一输出一个 JSON 对象，失败通过结构化错误和退出码表达。`doctor` 不读取钥匙串、不调用身份接口；显示连通性不等于认证成功。

## 直接调用：无需预登记接口

在浏览器已登录、扩展已授权且Profile已配对的前提下，Agent按[调用Skill](skills/intra-request/SKILL.md)整理用户材料后直接执行：

```bash
node dist/apps/cli/src/main.js request --profile work \
  --url 'https://api.example.test/items' --method POST \
  --json-file ./request-body.json --output ./response.json
```

上面URL是合成占位地址，载荷文件需由用户材料或Agent明确生成。也支持 `--json`、`--query-json`、非认证 `--headers-json`，以及 `--body-file` 配合显式 `--content-type` 原样发送UTF-8表单/文本。文件输入上限1 MiB，JSON和原始正文互斥。

默认不先体检、验证登录、登记接口或重复构建；CLI先复用完整缓存，缺失才同步。raw回执的ok只说明响应接收和保存，业务是否成功由Agent按实际响应和用户目标判断。URL模式不自动重试或跟随重定向。

### 作为 MCP 工具注册

`node dist/apps/mcp/src/main.js` 是 stdio MCP 服务，向 Agent 提供 `intra_request`、`intra_call`、`intra_read_artifact`、`intra_list_operations`、`intra_describe_operation`、`intra_status`、`intra_auth_check`。参数与CLI同校验，结果为同一ToolResult，正文只在artifact文件中。工具契约、注册配置和验证范围见[MCP说明](apps/mcp/README.md)。

扩展没有内置站点预设：用户输入要授权的域，或主动勾选所有HTTP/HTTPS网站；授权必须由用户在Chrome界面确认。每次Cookie读取仍绑定一个具体URL和Store，不全库导出。详情见[扩展说明](apps/extension/README.md)。

## 可选：为常用接口登记本地定义

```bash
node dist/apps/cli/src/main.js api register --file examples/services/risk-api.json
node dist/apps/cli/src/main.js api register --file examples/operations/risk-api.auto-interfaces.list.json
node dist/apps/cli/src/main.js api describe risk-api.auto-interfaces.list
```

登记只写本地配置，默认拒绝重复 ID；需要替换时显式传 `--replace`。数据目录默认为 `~/.intra`，可通过 `INTRA_HOME` 指定独立目录。示例不自动进入登记库。

浏览器桥完成安装、用户在扩展确认授权、CLI 配对并同步后，可以使用：

```bash
node dist/apps/cli/src/main.js auth profiles
node dist/apps/cli/src/main.js auth pair --profile work --profile-id PROFILE_ID --store STORE_ID
node dist/apps/cli/src/main.js auth sync --service risk-api --profile work
node dist/apps/cli/src/main.js call risk-api.auto-interfaces.list --profile work \
  --args-json '{"page":1,"pageSize":10}' --output ./interfaces.json
```

`PROFILE_ID` 和 `STORE_ID` 来自已连接扩展，不能直接复制占位符。构建不会自动完成浏览器桥安装，具体准备步骤见[宿主交付说明](packaging/native-host/README.md)。已用同一已知Operation完成第10页真实查询；其他页码或接口不由该结果推定已验收。

## 模块与阅读入口

| 模块 | 当前职责 |
|---|---|
| [CLI](apps/cli/README.md) / [Core](packages/core/README.md) | 命令适配、用例编排、身份探针和有界恢复 |
| [MCP](apps/mcp/README.md) | stdio MCP 工具适配，复用 Core 与 CLI 载荷校验 |
| [Contracts](packages/contracts/README.md) / [Registry](packages/registry/README.md) | AJV 2020-12 校验、JSON Pointer、站点/操作登记与请求组装 |
| [Discovery](packages/discovery/README.md) | 定义文件草稿和缺口报告；不自动解析 HAR 或观察网络 |
| [Credentials](packages/credentials/README.md) | Profile 隔离、CookieJar、Keychain 适配、刷新锁 |
| [HTTP](packages/http/README.md) | 逐跳请求、超时、响应分类、流式文件与完整性 |
| [扩展](apps/extension/README.md) / [Native Host](apps/native-host/README.md) | 显式授权、Native Messaging 与本地 Socket 快照桥 |

从概念开始读[新手入门](docs/01-beginner-guide.md)、[架构](docs/02-architecture.md)和[请求演练](docs/10-walkthrough.md)。实现依据见[设计基线](docs/design-baseline.md)、[规格契约](docs/04-contracts.md)、[凭据](docs/06-credentials.md)与[HTTP 和结果](docs/07-http-and-results.md)。

## 能力与验证边界

- 只读操作确认认证失效后最多刷新一次、重试一次；写操作和未知请求不自动重放。403 需要站点规则或身份探针分流。
- 请求参数保留 JSON 类型；HTTP 200 与业务成功分别校验。raw 模式只确认响应接收，明确返回业务成功状态未知。
- 原始响应保存到文件，只输出白名单摘要。默认 10 MiB 解码后预算、30 秒单次 HTTP 时限、最多 5 次只读重定向，不自动翻页，不覆盖已有文件。
- 不把 Cookie、认证头、原始异常或票据 URL 写进命令输出。分区 Cookie 明确拒绝；Secure Cookie 不走 HTTP。
- 不依赖 o2、WebCLI、Playwright 或 jd-login。历史实验仅是特定接口的证据，见[证据边界](docs/09-evidence-and-decisions.md)。
- `getPageInterIdList` 的方法、路径和 Payload 仍未知；不能套用已验证的 `getPageAutoInterfaceList`。

开发约束见[AGENTS](AGENTS.md)。
