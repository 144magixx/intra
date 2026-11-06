# 04 · 规格契约：模块之间传什么

契约就是双方约定的数据格式、成功条件和失败行为。本章是实现依据；开发版已经实现核心命令，具体覆盖与未验证项见[开发版状态](11-runtime-status.md)。机器可读格式在 [schemas](../schemas/README.md)，可复制的合成示例在 [样例索引](../examples/index.json)。

## 1. 对外命令

以下命令已有开发版入口。本文用 `intra` 简写本地构建后的 `node dist/apps/cli/src/main.js`，不表示已全局安装。CLI 不默认修改终端环境，不要求 Agent 获取 Cookie 明文。

| 命令 | 输入 | 输出/效果 |
|---|---|---|
| `intra doctor` | 无参数 | Node/平台、CLI和桥连接状态；macOS Keychain 为 `not-checked`，不读取钥匙串，不证明账号已认证或系统注册完整 |
| `intra auth profiles` | 无参数 | 可发现的扩展连接、Profile和Store信息，不是本地别名列表 |
| `intra auth pair --profile ALIAS --profile-id ID [--store ID]` | 已确认连接、别名、Store | 本地配对；多个Store需显式选择，账号仍未验证 |
| `intra auth sync --service S --profile P` | 站点ID、Profile别名 | 从已配对扩展快照同步；输出Cookie名称、来源、状态，不输出值 |
| `intra auth check --service S --profile P` | 站点、Profile | 用缓存调用配置的只读身份探针；没有探针返回 UNKNOWN，不自动同步或调用任意业务操作 |
| `intra api register --file PATH [--replace]` | Service或Operation的JSON定义 | 本地登记，不执行请求；重复ID返回REGISTRY_CONFLICT，仅显式--replace替换 |
| `intra api import --file PATH` | 人工整理的JSON操作材料 | 返回draft（完整时）、missing、source报告；不自动登记或执行 |
| `intra api describe ID` | 操作ID | 参数、语义、定义来源和验证时间 |
| `intra call ID --profile P [--args-json JSON] [--output PATH] [--timeout-ms N] [--max-bytes N]` | 操作ID与参数 | 根据定义执行并输出结构化结果 |
| `intra request --url URL --method M --profile P [载荷/查询/头/输出选项]` | 用户或Skill明确给出的完整URL、方法、请求数据 | 不要求预登记；只允许该URL的精确Origin，使用URL Cookie模式，业务语义unknown，不自动重放 |
| `intra request --service S --path PATH --method M --profile P [载荷/查询/头/输出选项]` | 已登记服务及明确路径 | 保留原始模式；与--url互斥 |

载荷选项三选一：`--json JSON`、`--json-file PATH`、`--body-file PATH --content-type TYPE`。文件必须是有效UTF-8常规文件，最多1 MiB；原始正文保留BOM、换行和空白，不做业务解析。JSON使用application/json；有载荷时headers-json不能另行设置Content-Type，原始正文必须通过--content-type明确类型。GET/HEAD不接受正文。

`--query-json JSON` 接受标量查询参数对象，不能与URL内已有同名参数冲突；`--headers-json JSON` 接受非认证字符串头，Cookie、Authorization、CSRF等受保护头不能注入。方法必须明确，不能从载荷推断；重复选项和模式冲突被拒绝。上述request也支持--output、--timeout-ms、--max-bytes。

直接URL模式机械解析协议、Origin和路径，不发现或猜测接口。临时Service只存在于当前调用，按Origin生成稳定缓存标识；显式HTTP URL仅为该精确Origin建立例外，Secure Cookie仍禁止通过HTTP发送。

`intra exec`、自动解析OpenAPI/HAR/cURL与网络观察不属于当前命令。Agent工具形态由stdio [MCP服务](../apps/mcp/README.md)提供：`intra_request`/`intra_call`与上述request/call同参同校验，另有artifact读取、operation列表/描述、状态与身份检查；配对、登记、import仍只在CLI。MCP结果的`structuredContent`即本章第6节ToolResult，以`error.code`代替退出码。`api import` 将完整输入降为draft并去掉verifiedAt；资料缺失时只返回缺口报告，需另行审核、登记。

stdout 只输出一个 UTF-8 JSON 对象；诊断信息只可写 stderr。`--output` 不覆盖既有文件，没有 overwrite 选项；必须另选路径。未指定时保存到 `INTRA_HOME` 下的 `outputs` 目录，数据目录默认 `~/.intra`。显式输出路径的父目录需已存在。`--replace` 仅针对登记定义。

单次HTTP时限默认30秒、最多300秒；解码后正文预算默认10 MiB、最多100 MiB。时限不是包含同步、探针和重试的整个CLI命令时限。省略 `--args-json` 时使用空对象及定义默认值。

退出码：0成功；2输入/契约；3登录/Profile/桥接；4业务权限；5网络；6业务失败或响应不符合定义；7输出/本地运行错误；8写请求结果未知。

## 2. 服务定义：访问哪里、用什么身份

见 [service.schema.json](../schemas/service.schema.json) 与 [Risk API服务](../examples/services/risk-api.json)。

| 字段 | 含义 |
|---|---|
| schemaVersion | 当前固定为1，未来不兼容格式必须升版本 |
| id | 本地服务唯一名称，不接受URL当身份标签 |
| baseUrl | 精确origin（scheme+host+port）；不带路径、用户名、密码或fragment |
| allowedOrigins | 精确scheme+host+port；HTTP客户端每一跳都检查 |
| auth.cookieNames | 可选；非空列表要求指定Cookie齐全，省略表示按URL取所有适用Cookie。空数组无效，不是Cookie值 |
| auth.identityProbeOperation | 可选，只读身份检查操作ID |
| auth.authFailureRules | 登录重定向、业务码或探针失败规则；不能把所有403都当登录失效 |
| protocolExceptions | 仅允许已说明的精确HTTP origin；不自动从HTTPS降级 |

Risk API暂未独立验证轻量身份接口，所以不配置identityProbeOperation。可用业务响应识别SSO跳转，但`auth check`不能冒充有独立探针。

## 3. 操作定义：如何组装一次业务调用

见 [operation.schema.json](../schemas/operation.schema.json) 与 [已验证配置化列表定义](../examples/operations/risk-api.auto-interfaces.list.json)。

| 字段 | 输入输出意义 |
|---|---|
| id/service | 本地操作唯一ID、关联服务ID |
| status | draft不能直接call；verified表示存在调用依据，来源必须可追溯，不保证此刻仍可用 |
| semantics | read/write/unknown；POST也可能是read，GET也不能仅凭方法认定无副作用 |
| arguments | 参数JSON Schema：类型、默认值、必填、范围 |
| request | method/path/query/headers/body，固定部分是请求骨架 |
| bindings | 把一个参数按类型写入query或body的JSON Pointer位置 |
| response | HTTP与业务成功条件、列表/总数/身份字段的JSON Pointer |
| provenance | 来源、验证时间和证据；verified须有合法且不晚于当前时间的带时区verifiedAt，以及非空evidence引用列表，每项非空白；不能伪造实测时间 |

参数处理顺序固定：拒绝未知参数 → 补default → 类型和范围校验 → 深拷贝request骨架 → 执行bindings → 校验最终URL/方法/认证头策略。

JSON Pointer示例：`/pageNo`指对象的pageNo；`/data/listResult`指嵌套列表。`~1`表示字段名里的`/`，`~0`表示`~`。v1不使用字符串模板、不eval代码；类型原样保留，整数2不能变成字符串"2"。绑定目标父节点必须存在，不自动猜嵌套结构；禁止`__proto__`、`prototype`、`constructor`等危险键。

query值用URLSearchParams编码，布尔false序列化为`false`，数组策略必须在后续协议中显式增加，MVP拒绝隐式拼接。body为JSON时使用UTF-8编码。接口定义不得固定Cookie、Authorization或代理认证头；这些由认证适配器提供。

登记只保存本地定义，不修改远端。draft可导入但不可运行；验证必须由已授权的只读请求或人工提供证据完成，不通过执行真实写操作自动验证。imported verified也不是可信授权，来源和semantic仍需校验。

## 4. 模块函数契约

这里是模块职责示意，不保证函数名和形参与当前源码导出相同，也不是稳定公共API。运行时已有实现，实际调用方式以源码为准。

| 函数 | 输入 | 输出 |
|---|---|---|
| registry.resolve | operationId,args | service、materializedRequest、semantics、responseRules |
| credentials.resolve | profileId,accountId?,url,cookieNames | credentialRef、metadata，或分类错误 |
| browser.snapshot | profileId,storeId,url,cookieNames,deadlineMs | Cookie快照；含秘密，仅内部传递 |
| http.execute | materializedRequest,credentialRef,context | status、responseHeaders内部引用、bodyRef、bytes、timing |
| response.classify | rawResponse,responseRules,authRules | success/authExpired/forbidden/businessError/schemaMismatch/unknown |
| output.persist | bodyRef,target,budget,policy | artifact、summary、complete |

`credentialRef`是当前调用进程内、绑定Profile/账号/目标origin的短生命周期引用，不是Token替代品或可公开的万能访问凭据。跨进程调用应在接收进程重新resolve，不能只猜一个ID就读钥匙串。

## 5. 浏览器桥协议

[ipc.schema.json](../schemas/ipc.schema.json) 描述消息外壳。`schemaVersion/requestId/type`为公共字段。request含method和params；成功response含ok=true/result；失败response含ok=false/error。每次请求只对应一个最终响应；逾期响应按requestId丢弃。

| 方法 | 路径与用途 | MVP状态 |
|---|---|---|
| bridge.hello | 扩展→宿主，声明profileId、版本和storeIds | 已实现；真实Chrome待验收 |
| cookies.snapshot | CLI→宿主→扩展，限定URL、Cookie名称与时限 | 已实现；合成桥测试不等于浏览器验收 |
| credentials.resolve | 核心库内部接口；IPC名称预留 | 不经扩展，不开放任意读取 |
| http.execute | 未来本地服务模式预留 | MVP不用；CLI本进程执行HTTP |
| cookies.changed | 扩展→宿主的后续增量事件 | v2路线，不宣称现已同步 |

示例：[名称过滤快照请求](../examples/messages/snapshot-request.json)、[自动URL快照请求](../examples/messages/url-snapshot-request.json)、[快照响应](../examples/messages/snapshot-response.json)。响应示例使用`EXAMPLE_NOT_A_REAL_CREDENTIAL`，不得用真实值替换后提交。

0.3.0的快照`cookieNames`可省略，表示当前URL适用的全部Cookie；显式列表须1–16个唯一合法名称，每个1–256字符。空数组非法。快照始终有具体URL和Store，不提供整仓读取。URL模式要求至少一条未过期适用Cookie；内部记录完整模式标记，只复用相同Origin和pathname的缓存，query变化不影响复用。原先按名称筛选的缓存不能冒充完整URL快照。IPC版本仍为1，旧扩展需重载到0.3.0后才能使用新模式。

IPC外壳Schema不能单凭response判断它对应哪种method；接收端必须依据requestId的未完成请求表，将cookies.snapshot结果再按`$defs.snapshotResult`验证。检查器对该样例做这一补充验证。

Native Messaging使用4字节本机字节序的消息长度前缀，随后是UTF-8 JSON。扩展→宿主Chrome上限64MiB，宿主→扩展1MiB；Intra MVP把双向单帧限制为256KiB，超限明确失败，不截断Cookie数组。宿主stdout只能输出协议帧，日志写stderr。

Chrome connectNative由扩展发起并启动宿主。CLI检查元数据、Socket及所在目录的所有者和权限：目录0700，元数据与Socket为0600。macOS标准Node没有可用的SO_PEERCRED接口，当前不能声称完整验证双方UID。Native Host校验真实扩展来源，注册的allowed_origins只能包含对应扩展ID。

## 6. 对Agent的结果契约

见 [tool-result.schema.json](../schemas/tool-result.schema.json)、[成功示例](../examples/messages/success-result.json)、[登录失败示例](../examples/messages/login-required-result.json)。

- 已登记operation的 `ok=true` 表示HTTP、业务码和结构满足该定义。raw `request` 没有业务成功规则，是明确例外：`ok=true` 仅表示2xx响应已接收并保存，`data` 为 `{"status":"received","businessSuccess":"unknown"}`，仍会应用服务认证失败规则。管理命令的ok表示该命令完成，不表示账号认证成功。
- `data`在现有Schema中保持通用结构；运行时按命令输出安全摘要或本地定义。上述raw字段是当前行为，不是新增的Schema必填字段。`artifact`指业务响应文件。
- `artifact.complete=false`表示不完整，不能同时用一个伪造的成功结果声称全量完成。
- `meta.timingMs`记录凭据/HTTP/输出/总耗时，不包含用户发消息到Agent启动命令的等待。
- `error`有code、message、retryable、action；与成功结果互斥。
- 对外不包含Cookie/Authorization、原始Set-Cookie、带票据的完整Location或含认证信息的异常堆栈。

## 7. 错误分类

| code | 意义与下一步 | exit |
|---|---|---:|
| INVALID_ARGUMENT / CONTRACT_INVALID / SERVICE_NOT_FOUND / OPERATION_NOT_FOUND / OPERATION_UNVERIFIED / REGISTRY_CONFLICT | 修正参数/定义，不能静默猜接口 | 2 |
| PROFILE_NOT_PAIRED / PROFILE_AMBIGUOUS / ACCOUNT_MISMATCH | 选择或配对正确身份 | 3 |
| BRIDGE_UNAVAILABLE / COOKIE_NOT_FOUND / LOGIN_REQUIRED | 同步或用户登录；不循环重试 | 3 |
| AUTH_EXPIRED | 内部恢复信号，最终无法恢复则LOGIN_REQUIRED | 3 |
| PARTITIONED_COOKIE_UNSUPPORTED | 此认证方式未适配，保留分区元数据 | 3 |
| FORBIDDEN | 有效身份无此权限，停止刷新 | 4 |
| AUTH_STATE_UNDETERMINED | 无可靠探针无法区分认证/权限；不擅自重登 | 3 |
| NETWORK_UNREACHABLE / REQUEST_TIMEOUT | 网络问题；不当作Cookie过期 | 5 |
| BUSINESS_ERROR / RESPONSE_SCHEMA_MISMATCH | 检查业务参数或接口变更 | 6 |
| RESPONSE_TOO_LARGE / OUTPUT_EXISTS / OUTPUT_ERROR / REGISTRY_ERROR / PROTOCOL_MISMATCH / INTERNAL_ERROR | 返回保存状态与路径；不伪造完整文件 | 7 |
| KEYCHAIN_UNAVAILABLE | 钥匙串或原生助手不可用；不降级为明文文件 | 7 |
| REFRESH_LOCK_TIMEOUT | 刷新锁等待超时，停止等待并检查并发任务 | 7 |
| REQUEST_OUTCOME_UNKNOWN | 写请求或unknown请求可能已执行，需查状态或幂等恢复 | 8 |

认证恢复最多一次。只有已登记且批准的read操作，或未来有明确幂等契约的写操作才允许重放；未知raw请求默认不重放。

## 8. 版本演进

服务和操作定义以schemaVersion区分。加载未知主版本必须拒绝，不能尽力执行；新增可选字段也要先更新Schema。examples、Schema、实现和测试同时更新。扩展和宿主hello交换支持版本，找不到交集就报PROTOCOL_MISMATCH（本地运行错误，exit7）。
