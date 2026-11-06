# MCP 服务：把 Intra 注册为 Agent 工具

`apps/mcp` 是 stdio MCP 服务，复用 [Core](../../packages/core/README.md) 与 CLI 的载荷校验，不重写认证、网络或输出逻辑。服务进程就是 Intra 进程：它自己读 Keychain、发 HTTP，Cookie 不出现在任何 MCP 消息里。只走 stdio，不监听端口。

```bash
npm run build
node dist/apps/mcp/src/main.js   # 由 MCP 客户端启动；stdout 只输出协议帧
```

## 工具清单

| 工具 | 对应实现 | 注解 | 说明 |
|---|---|---|---|
| `intra_request` | `Core.requestURL` / `Core.request` | 非只读、非幂等、openWorld | 明确 URL+方法+载荷；raw 语义 unknown，不重放 |
| `intra_call` | `Core.call` | 非只读、非幂等、openWorld | 已登记且 verified 的 operation |
| `intra_read_artifact` | 本服务 | 只读 | 结构概览、JSON Pointer 取值、UTF-8 字节分页，单次最多 64 KiB |
| `intra_list_operations` | `Registry.listOperations` | 只读 | 本地登记的 operation 摘要 |
| `intra_describe_operation` | `Registry.getOperation` | 只读 | 参数、请求骨架、响应规则、来源 |
| `intra_status` | 与 `doctor`、`auth profiles` 同源 | 只读 | 桥连接与本地 Profile 别名；不读 Keychain |
| `intra_auth_check` | `Core.authCheck` | 只读 | 只调用已登记身份探针；无探针返回 UNKNOWN |

配对（`auth pair`）、登记（`api register`）、`api import` 和显式 `auth sync` 不开放给 Agent，仍由用户经 CLI 执行；请求缺缓存时 Core 会自行按 URL 同步一次。

## 契约

- **输入**：每个工具的 `inputSchema` 都是 `additionalProperties: false` 的 JSON Schema，由服务端用 AJV 2020-12 先校验。`intra_request` 的字段与 CLI 选项一一对应（`json`/`jsonFile`/`text`+`contentType`/`bodyFile`+`contentType` 四选一，`query` 只收标量，`headers` 拒绝认证类头和与正文并存的 Content-Type），随后交给与 CLI 相同的 `requestInput` 和 Core 校验。
- **输出**：`structuredContent` 就是 [tool-result.schema.json](../../schemas/tool-result.schema.json) 定义的 ToolResult，并作为 `outputSchema` 声明；`content[0].text` 是同一对象的 JSON 文本；`isError = !ok`。协议版本低于 2025-06-18 时只返回文本。MCP 没有退出码，以 `error.code`、`retryable`、`action` 为准；参数错误的 `action` 指出具体字段。
- **正文不内联**：响应正文只保存在 `artifact.path`，用 `intra_read_artifact` 先看 `structure`，再按 `pointer` 取字段。读取范围限于本服务返回过的 artifact 及 `INTRA_HOME/outputs` 下的文件，不跟随符号链接。
- **语义**：raw 请求 `ok=true` 仅表示 2xx 已接收，`data.businessSuccess` 为 unknown；`REQUEST_OUTCOME_UNKNOWN` 时不得重发。
- **边界**：服务端 `instructions` 要求 Agent 在 Intra 工具无法完成指令或用户信息不全时停下来询问用户，不得改用浏览器自动化、o2/WebCLI、jd-login、企业 CLI 或自写 HTTP 客户端等手段，除非用户明确指定。

## 运行行为

- 网络类工具（request、call、auth_check）在单个服务进程内串行执行，避免凭据刷新和输出路径竞争；只读查询类工具可并发。
- `notifications/cancelled`：尚在队列中的调用直接丢弃、不发网络；已开始的调用不中止（请求可能已执行），跑完并保存 artifact，只是不再回复。
- `timeoutMs` 上限默认 100000，需小于客户端工具超时（DSH 示例配置 120000）。
- 单帧上限 8 MiB；不支持 JSON-RPC 批量；初始化前只接受 `initialize` 与 `ping`。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `INTRA_HOME` | `~/.intra` | 数据目录，与 CLI 共用 |
| `INTRA_DEFAULT_PROFILE` | 无 | 省略 `profile` 时使用的已配对别名；未设置则必须显式传入 |
| `INTRA_MCP_MAX_TIMEOUT_MS` | `100000` | `timeoutMs` 上限，1–300000 |

## 注册到 DSH

在 profile 的 `cordis.patch.yml` 中插入一行 `@deepseek-ai/dsh-mcp-client`（路径按本机替换为绝对路径）：

```yaml
- insert:
    - id: mcp-intra
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: intra
        transport: stdio
        command: /ABSOLUTE/PATH/TO/node
        args:
          - /ABSOLUTE/PATH/TO/intra/dist/apps/mcp/src/main.js
        env:
          HOME: /Users/USER
          INTRA_HOME: /Users/USER/.intra
          INTRA_DEFAULT_PROFILE: work
        toolCallTimeoutMs: 120000
```

其他支持 stdio MCP 的客户端使用同样的 command/args/env。

## 验证范围

[MCP 测试](../../tests/mcp.test.ts) 用内存流、合成 Cookie 和本地回环 HTTP 服务覆盖：协议协商、工具清单与注解、JSON/原始正文、参数拒绝不触发同步或网络、不重放、串行与取消、artifact 读取边界与 UTF-8 分页、operation 列表/描述/调用、帧错误。这些是合成测试，不等于在某个 MCP 客户端里的真实站点验收。
