# 11 · 开发版状态与验证范围

本轮在 M0 文档基础上开始实现运行时。Git 的 `main` 首个提交 `4b6f83c` 保存原始 55 个文件；后续代码作为独立开发变更。

## 已实现的模块

| 模块 | 实现 | 验证方式 |
|---|---|---|
| Contracts / Registry | AJV 2020-12、严格 JSON Pointer、参数默认值与类型、本地原子登记、来源约束 | 合成定义、负向测试、并发登记 |
| Discovery | JSON 定义导入、draft 降级、缺口报告 | 未知接口不填造方法/路径，不自动登记 |
| CLI / Core | 命令解析、ToolResult、退出码、身份探针、有限恢复与刷新锁 | 独立 CLI 子进程及本地模拟服务 |
| HTTP / Output | Node fetch、逐跳允许来源检查、30 秒默认时限、10 MiB 解码预算、原子文件提交 | 参数类型、gzip 超限、正文超时、输出竞争、写入后断连 |
| Credentials | Profile/Store/服务/Origin 隔离、tough-cookie、不可跨进程解析的引用、Keychain 适配 | 内存 SecretStore、合成 Cookie、原生调用 runner 替身 |
| Extension / Native Host | 授权弹窗、MV3 worker、Native Messaging、受限 Socket、请求关联与 deadline | 模拟 Chrome API、合成消息、真实本地 Socket |

以上“已实现”描述代码状态，不代表真实网站验收。2026-11-05 在 macOS、Node.js v24.21.0 下执行 `npm run check`：TypeScript构建通过。扩展0.3.0、可选Cookie名称和直接URL执行集成后，**139项自动测试全部通过，0失败、0跳过**（其中桥接31项、凭据35项、直接调用9项），文档/Schema子集/15份样例检查通过。自动测试使用合成凭据和本地回环HTTP服务；真实浏览器测试的独立结果见下文。

验证入口：[运行时测试](../tests/README.md)、[HTTP 回归](../tests/http.test.ts)、[Core 集成](../tests/core.test.ts)、[凭据测试](../tests/credentials.test.ts)、[桥接测试](../tests/bridge.test.ts)。

## 通用网站与 Agent 快速调用

扩展0.3.2没有内置站点预设，支持自定义域，或用户主动勾选全部HTTP/HTTPS网站；全部网站默认不选，不能自动授权。所有Cookie读取都指定一个URL和Store，省略名称过滤器时取该URL适用Cookie，不读整仓。

用户提供截图或F12复制的URL、方法、载荷和查询意图，由项目[调用Skill](../skills/intra-request/SKILL.md)归一化；CLI只接受明确入参。`request --url`无需Service/Operation登记，支持JSON、UTF-8正文文件、标量query和非认证headers，不猜参数、不发现接口。raw保持unknown且不重放。

快速路径不先跑doctor/auth check/auth sync/登记/describe，不重复构建测试。已有完整缓存直接请求；同一pathname换query页码复用缓存，换路径需要新快照。合成[直接请求集成测试](../tests/direct-request.test.ts)检查一次业务调用只有一次HTTP请求、没有额外身份探针/登记，并验证JSON文件、原始正文和缓存隔离。这里证明控制流和请求计数，不承诺实际站点延迟或模型响应时长。

0.3.0已获得用户授权，并于2026-11-05完成Risk API第10页真实查询与Keychain存取。0.3.1移除两个示例站点预设，0.3.2移除最后一个公司域预设；所有域都通过自定义域或全站入口授权。其他网站和直接URL模式的真实调用仍需各自验证。

## 开发使用

```bash
npm ci
npm run build
npm test
npm run check:docs
node dist/apps/cli/src/main.js --help
node dist/apps/cli/src/main.js doctor
```

`INTRA_HOME` 控制独立数据目录，默认 `~/.intra`。CLI 的生产凭据后端只使用 macOS Keychain；MemorySecretStore 仅供测试注入，没有 CLI 明文凭据导入开关。

登记顺序是 Service → Operation。`api register --file PATH` 默认拒绝重复 ID；`--replace` 才替换。`api import --file PATH` 只返回 draft/缺口，不保存或发请求。`verified` 要有合法的验证时间和非空证据引用；真实来源与读写语义仍需用户审核。

缓存有效时，`call` 无需浏览器在线。缺少缓存时按已配对身份请求快照；已确认认证失败的 read 操作最多同步一次、重放一次。没有身份探针的服务保持 `account-unverified`。`auth check` 无探针时返回 UNKNOWN，不调用其他业务接口。

raw `request` 保持 `semantics=unknown`，不会自动重放。它没有业务成功规则，所以成功回执明确包含 `businessSuccess: "unknown"`，对应[raw 样例](../examples/messages/raw-result.json)。

## 浏览器桥准备

浏览器桥使用[扩展源码与构建说明](../apps/extension/README.md)及[宿主产物生成器](../packaging/native-host/README.md)。生成器需要真实扩展 ID、Node 可执行文件绝对路径和编译后的宿主入口路径；只生成文件，不修改 Chrome 系统注册目录。

扩展由用户确认站点权限后调用 `connectNative` 启动宿主。CLI 不启动扩展。`auth profiles` 发现连接后，以 `auth pair --profile work --profile-id ID --store STORE_ID` 显式配对，再执行 `auth sync`。

宿主限制扩展 Origin，运行目录 0700、Socket 0600，检查文件归属和描述符。标准 Node 在当前 macOS 实现中未直接调用 SO_PEERCRED；不能宣称已完成该级别的内核对端身份认证，也不能防御已控制同一 OS 用户的进程。

## 真实浏览器测试：第10页已成功

2026-11-05 20:25–20:26（Asia/Shanghai）按用户要求测试 Risk API 第10页，每页10条。Chrome 147.0.7727.56 与扩展0.1.0完成真实Native Messaging/Socket连接，Profile配对成功；`auth sync` 返回 `COOKIE_NOT_FOUND`，实际接口URL的快照同样匹配到0条所需Cookie，尚未进入Keychain存取，也未发送业务HTTP。

源码核对确认旧扩展只申请服务子域权限，Chrome `getAll` 会进一步按Cookie所属域及Secure对应协议过滤，可能隐藏历史位于 `.corp.example` 的共享登录Cookie。扩展0.2.0按用户要求改为统一 `corp.example` 根域和子域可选授权；新增同公司站点不再需要改桥接名单。这次失败的[无凭据测试记录](../evidence/intra-e2e-risk-api-2026-11-05.json)保留当时的时间、范围和实现来源。

2026-11-05 21:44:36–21:44:37（Asia/Shanghai）使用提交6517641、扩展0.3.0和当前已确认的work-current配对重试成功：HTTP200、业务码字符串200，返回pageNo=10、pageSize=10、count=10、totalRecord=589、totalPage=59，完整正文4,235,500字节且权限0600。成功CLI调用耗时1,478ms，其中HTTP约1,203ms；这是该次成功命令的实测耗时，不包含之前的配对修复及对话等待。随后另一个本地进程成功读取Keychain缓存，未追加业务请求。见[成功验证记录](../evidence/intra-e2e-risk-api-page10-success-2026-11-05.json)。原始业务响应留在本机outputs目录，不进入仓库。

## 未验收和当前限制

- 首轮开发未安装扩展或注册宿主；此后的真实测试已由用户加载扩展，并完成宿主注册、连接和Profile配对。Risk API这次已通过真实Keychain写入、跨进程缓存读取和业务HTTP查询；不推广为其他网站的验收结论。
- Objective-C Security.framework 助手通过父进程私有 stdin/stdout 收发 JSON，秘密不出现在命令行参数或环境变量。2026-11-05 已使用本机 Clang 在临时目录编译成功，产物权限 0700；随后已在该次Risk API测试中实际调用助手读写Keychain。锁定、拒绝访问和其他环境仍需验收。
- Chrome Profile复制冲突、异常断连/恢复、关闭浏览器后的缓存调用，以及目标版本 MV3 生命周期仍需实机验收。
- Node 的企业代理、PAC、企业 CA、VPN 和 DNS 行为未验证；不会关闭 TLS 验证。
- 目标 Origin 的缓存独立选择，跨站跳转缺少目标凭据就停止，不盲目转发原 Cookie 或在跳转途中同步浏览器。目标站点返回认证问题时，原站点探针不能证明其身份，返回 AUTH_STATE_UNDETERMINED，不错误报告权限不足或刷新原站点。
- HTTP Set-Cookie 只更新当前调用的会话，不反写 Chrome。Keychain 旧不可变快照暂保留给并发读者，没有自动垃圾回收或凭据管理删除命令。
- 扩展0.3.0与宿主支持任意HTTP/HTTPS站点，需用户按域或显式全站授权。`request --url`不要求预登记，临时Service仅允许该精确Origin，默认按URL选择Cookie。没有任何网站因代码支持而被自动授权；除记录中的Risk API请求外，其他站点均未真实调用验收。
- Cookie名称过滤可省略；自动URL模式至少需要一条适用Cookie，旧名称筛选缓存不能冒充完整快照。缓存仅复用原Origin+pathname，query换页可复用，换路径需要浏览器新快照；不跨站合并Cookie。
- 扩展断开、Chrome/worker 重启后需用户重新确认连接；自动重连未实现。Unix Socket 路径超过 103 字节时需使用更短的 `INTRA_HOME`。
- 分区 Cookie、无痕同步、全域增量同步、自动 HAR/cURL 解析、浏览器请求观察和其他系统凭据后端尚不支持。
- 2026-11-06 新增 stdio [MCP服务](../apps/mcp/README.md)（7个工具）。合成[MCP测试](../tests/mcp.test.ts)12项通过，全量152项通过；同日17:2x（Asia/Shanghai）注册为DSH `mcp-intra`（`@deepseek-ai/dsh-mcp-client` stdio，默认Profile work-current）后，经DSH工具调用 `intra_call risk-api.auto-interfaces.list {page:10,pageSize:10}`：HTTP200、业务码"200"、count=10、total=589、正文4,235,500字节完整，凭据走Keychain缓存未刷新，总耗时约4.2s（HTTP约4.16s）；随后 `intra_read_artifact` 结构模式读取成功。其他站点和 `intra_request` 直接URL模式经MCP的真实调用仍未验收。MCP取消不会中止已开始的HTTP请求，只抑制回复。
- 身份探针只读且需返回非空身份字段；业务响应文件按任务原样保存，可能包含敏感业务数据。默认命令摘要仅含声明的 count/total/identity。
- `--output` 不覆盖已有文件；不支持 overwrite。超过预算或正文中断保留带随机后缀的 `.partial`，报告实际字节数和完整性。

历史真实接口证据仍是 2026-11-04 的独立实验，见[证据与决策](09-evidence-and-decisions.md)，不作为当前运行时验收结果。
