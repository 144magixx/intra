# CLI 入口

源码见 [main.ts](src/main.ts)。构建后使用 `node dist/apps/cli/src/main.js`，或 `npm run intra -- <命令>`。

实现 `doctor`、`auth profiles/pair/sync/check`、`api register/describe/import`、`call` 和 `request`。严格解析选项，拒绝重复选项、非法 JSON 和多余位置参数；stdout 输出一个 ToolResult，失败返回契约退出码。错误不回显输入值、文件路径或文件内容。

`request` 执行已经明确的输入。Agent Skill 根据用户的 F12 截图、复制的 URL / Method / Payload 和任务意图整理参数；CLI 不解析截图、不发现接口、不推断业务字段，也不根据正文推断方法。

```bash
node dist/apps/cli/src/main.js request \
  --url 'https://api.example.test/items?view=recent' --method POST --profile work \
  --json '{"page":2,"active":false}' --query-json '{"limit":10}' \
  --headers-json '{"Accept":"application/json"}' --output ./response.json
```

这是输入格式示例，未向该站点发送请求。`--url FULL_URL` 不需要预先登记 Service 或 Operation；Core 使用仅限该 URL 精确 Origin 的临时服务。`--method`、`--profile` 必填。旧入口 `request --service ID --path PATH --method METHOD --profile ALIAS` 保留，与 `--url` 互斥，并支持相同的正文、查询、请求头和输出选项。

正文最多选择一种：

| 选项 | 行为 |
|---|---|
| `--json JSON` | 解析 JSON，保留数字、布尔、null 等类型；Content-Type 为 application/json |
| `--json-file PATH` | 从最多 1 MiB 的 UTF-8 常规文件解析 JSON，同样保留类型 |
| `--body-file PATH --content-type TYPE` | 从最多 1 MiB 的 UTF-8 常规文件读取原文，按指定 Content-Type 发送；保留 BOM、换行、空白和已有编码，不做表单编码 |

文件先 open/fstat，再做有界读取；拒绝目录、FIFO、超限和非法 UTF-8。`--content-type` 仅用于 `--body-file`；使用任一正文选项时，`--headers-json` 不得再含 Content-Type，以免多个来源产生歧义。GET / HEAD 不接受正文。`call` 仍只通过 `--args-json` 接收操作参数。

`--query-json` 必须是对象，值只能是字符串、有限数字或布尔值；不接受数组、嵌套对象和 null，不允许与 URL 自带查询键重复。`--headers-json` 必须是字符串值对象，头名称大小写不敏感地去重；Registry 继续禁止 Cookie、Authorization、Proxy、CSRF、Host 等凭据或传输控制头，直接模式没有绕过入口。

浏览器配对和站点权限仍需用户授权。URL 模式没有固定 Cookie 名单，凭据模块按目标 URL 选择已授权且匹配的 Cookie；已登记服务可选填 `auth.cookieNames`，提供时继续限制名称。Cookie 由凭据模块注入，不由 CLI 参数传入。直接请求保持 `semantics=unknown`，不自动重放；`ok=true` 只表示 2xx 响应已接收并保存，`data.businessSuccess` 为 `unknown`。

默认数据目录 `~/.intra`，`INTRA_HOME` 可指定独立目录。`api register` 同时接受 Service 和 Operation 文件，默认禁止覆盖；`api import` 仅返回草稿/缺口，不自动登记或验证。

`doctor` 不触发 Keychain 读取，未实际检测的钥匙串状态写为 `not-checked`。`auth profiles` 显示当前连接，配对必须使用扩展已确认的 Profile ID；存在多个 Store 时显式选择 `--store`。

请求可配置 `--timeout-ms` 和 `--max-bytes`，不支持覆盖输出文件。未传输出路径时保存到数据目录的 outputs 子目录。生产 CLI 只使用 macOS Keychain；内存凭据存储仅供库测试。新增输入行为以合成数据和本地 HTTP 服务验证，不代表任何真实站点、Chrome 或 Keychain 验收。

见[运行状态与使用步骤](../../docs/11-runtime-status.md)、[命令契约](../../docs/04-contracts.md)。
