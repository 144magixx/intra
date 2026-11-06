# 07 · HTTP执行、响应判断与结果文件

HTTP客户端像一个带身份的程序化请求器。它不点击网页、不调用页面fetch；拿到已知请求定义后，在CLI进程里直接联网。本章是执行契约，开发版实现和测试范围见[开发版状态](11-runtime-status.md)。

## 1. 一次请求的执行步骤

1. 校验operation已验证、service存在、参数合法；raw模式标记semantics=unknown。
2. 拼接baseUrl与path，拒绝协议相对路径、userinfo、fragment、路径中注入另一个origin。
3. 按bindings填充query/body，保留数字/布尔类型，认证头不从用户参数直接拼接。
4. credentials.resolve读取当前Profile的缓存；没有才请求浏览器同步。
5. 从CookieJar选取目标URL适用Cookie，发送请求。
6. 流式读取正文到受限临时文件，避免2MB以上响应反复进入Agent上下文。
7. 判断认证、HTTP、业务码与结构，按输出模式返回结果。

普通请求不先发一遍身份探针。身份检查是显式auth check，或错误分流时才调用。

## 2. MVP请求范围与默认值

- 支持GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS、query和JSON body。表单、multipart、流式上传留作后续能力；未知格式返回不支持，不能替调用方猜编码。
- 单次HTTP总时限默认30秒，包含连接、响应头与正文接收，可用--timeout-ms设置正整数毫秒（最多300000）；同步、探针和重试可能各自消耗时限，不是整个CLI命令的总截止时间。
- 输出预算默认10MiB，可用--max-bytes设置正整数字节（最多100MiB），按解码后业务正文实际字节计数；压缩传输也需解码后预算，不能只检查Content-Length。
- 最大重定向5跳；每跳重新解析URL、审核origin、匹配Cookie。
- 默认不自动分页。分页必须有显式页数/记录/字节/总时限预算，属于后续选项。
- Node版本与网络适配需验证企业代理、PAC/系统代理、DNS和企业CA；不能默认它与Chrome网络配置等价。不得通过关闭TLS验证“修复”认证失败。

这些是当前运行时默认值，不是服务端能力边界。Risk API的pageSize合法最大值未测定，不能凭样例声明100或1000是上限。

## 3. 重定向如何处理

Node fetch使用manual重定向，由本工具逐跳决策。跨origin不能把原来的Cookie、Authorization、CSRF头原样转发；即使同属corp.example，也重新按服务白名单和Cookie属性选择。快照按origin隔离，目标origin必须已有独立缓存；缺失时停止，不在重定向途中自动请求浏览器。

遇到已登记SSO登录地址，停止业务重定向并分类AUTH_EXPIRED，不自动访问未知SSO回调或尝试兑换。普通301/302不是登录失效的充分条件。

写请求的301/302/303可能改变HTTP方法；MVP不自动继续写请求的重定向。307/308虽然保留方法，也不代表业务安全可重放。只读定义可以有明确的重定向策略，且仍受origin限制。

DevCloud样例历史使用HTTP，只对`http://devcloud.corp.example`保留精确例外；Secure Cookie仍不发送。不为其他站点继承HTTP例外，也不宣称HTTPS已经验证。

## 4. 响应判断顺序

| 顺序 | 判断 | 结果 |
|---|---|---|
| 1 | 网络/TLS/DNS/超时 | NETWORK_UNREACHABLE / REQUEST_TIMEOUT；已发送的写/unknown请求可能归为REQUEST_OUTCOME_UNKNOWN |
| 2 | 已确认登录跳转/业务认证码 | AUTH_EXPIRED |
| 3 | 401/403等身份或权限模糊状态 | 用已配置探针分流；无探针则AUTH_STATE_UNDETERMINED |
| 4 | 预期JSON却得到HTML/乱码/无效JSON | RESPONSE_SCHEMA_MISMATCH |
| 5 | HTTP与业务码是否满足精确规则 | BUSINESS_ERROR或继续 |
| 6 | 列表/身份/分页字段是否存在且类型正确 | 成功或RESPONSE_SCHEMA_MISMATCH |

字符串`"200"`和数字`200`分别保存，不能把所有code强转字符串来掩盖服务端变更。DevCloud`HTTP200 + code304`需要按该站点规则判定认证失效；不能把同样的304规则推广到任何接口。

上述业务码与结构检查适用于已登记operation。raw `request` 只有服务认证规则与HTTP状态判断：2xx接收并保存后返回 `ok=true` 和 `data: {"status":"received","businessSuccess":"unknown"}`，不能理解为业务成功；它是operation成功语义的明确例外。现有tool-result Schema的data保持通用，未新增业务成功必填字段。

身份探针只有返回预期非空用户名才算身份有效；若已经绑定账号还需与expectedAccountId比较，返回另一个账号属于ACCOUNT_MISMATCH。跨origin重定向后遇到403、认证业务码或SSO跳转，原origin探针不能证明目标身份；当前返回AUTH_STATE_UNDETERMINED，不据此推断FORBIDDEN，也不刷新原origin凭据。

## 5. 认证恢复与请求重放

| 操作 | 凭据失效后行为 |
|---|---|
| 已登记semantics=read | 至多同步一次；新凭据有效时至多重放一次 |
| raw未知请求 | 可以报告认证问题；默认不自动再次发送 |
| 写请求且没有幂等契约 | 不盲目重放；响应丢失时REQUEST_OUTCOME_UNKNOWN |
| 有明确幂等键/状态查询的写操作 | 后续单独适配，不在MVP泛化 |

更新凭据与重放业务请求是两个决策。不能因为“可以重新获取Cookie”就默认可以重发业务请求。列表POST只有经过接口定义确认只读，才适用read策略。

## 6. 大响应与文件

默认采用文件模式：完整保存业务响应，并返回小摘要。未指定--output时，业务结果保存到INTRA_HOME下outputs目录；默认数据目录为~/.intra。当前摘要通过定义中的itemsPointer、totalPointer、identityPointer生成count、total、identity，不支持任意字段选择参数。显式auth check返回安全身份摘要，不能把完整principal响应直接送给Agent。

文件写入过程：

1. 在目标目录创建0600临时文件，不覆盖既有路径。
2. 流式写入并计算bytes，监测解码后预算与超时。
3. 全部读取且成功校验后原子提交最终文件；已有目标时返回OUTPUT_EXISTS；没有overwrite选项。
4. 接收中断或超过预算时，保留的临时文件标明.partial，报告complete=false和已写字节；空临时文件可能被清理。若正文完整但文件提交失败，仍可报告complete=true的临时文件，不能把文件名后缀当成完整性判据。
5. 如已完整读取业务错误响应，可保存原始业务错误文件，ok仍为false。

完整业务数据与认证元数据是不同对象：业务正文按任务原样保留，日志/manifest/对话不能带Cookie、Authorization、原始Set-Cookie或带票据的跳转URL。业务正文自身可能含敏感字段，工具默认不把其全部展开到Agent结果；后续读取文件时再按任务选择字段，当前CLI没有任意摘要字段选择开关。

响应摘要的total是服务端报告总量，count是本次取回数量。10条/849总量不等于导出了849条。JSON Pointer取值不存在时返回结构错误，不能替换成空列表来伪装无数据。

## 7. 输出示例与计时

[成功结果](../examples/messages/success-result.json) 展示文件、count/total、HTTP/业务码及timingMs。示例数字是合成展示，不是本项目性能测试。

计时在Core执行阶段用monotonic时钟记录：credential包括缓存/同步等待；http包括请求、正文读取和当前响应解析；output主要记录最终文件提交；total是Core执行总耗时，不包括CLI启动和前置登记解析。错误分流中的探针等时间未必完整归入三个分项，不能要求分项之和与total严格相等。

用户发消息到开始命令的时间属于Agent层，不属于HTTP客户端耗时。历史13ms/57ms等结果只说明当时轻量接口的单次响应，不能承诺每次工具调用都低于1秒。

## 8. 模块边界

HTTP模块不知道“查询接口列表”的中文含义；它执行明确请求。registry知道参数绑定与结果规则，credentials知道身份和Cookie，output知道文件与摘要，core统一调度和错误分类。

这样既可给Agent一个通用request入口，也能为常用业务建立operation；后续MCP复用core，不再重写认证和网络逻辑。
