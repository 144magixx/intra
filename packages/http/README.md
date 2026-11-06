# HTTP 与输出

实现见 [index.ts](src/index.ts)。使用 Node fetch，显式处理重定向、总时限、解码后字节预算和文件提交；响应分类依据 Service / Operation 规则。HTTP 只执行已明确的 URL、方法、查询、请求头和正文；F12 截图或复制请求的整理属于 Agent Skill，不解析截图、不发现接口、不推断业务参数。

- `rawBody` 是内部直接请求字段，按 UTF-8 原文发送，不做 JSON 包装、表单编码或换行处理；必须明确 Content-Type。`body` 仍按 JSON.stringify 发送，且仅 JSON 正文缺少 Content-Type 时补 application/json。两种正文互斥，GET / HEAD 禁止正文；Operation 定义仍只支持 JSON 正文。
- 请求头和查询继续经 Registry 校验：拒绝凭据头、传输控制头、大小写重复头、非标量查询以及 URL / query 的重复键。
- 每一跳校验允许 Origin，并重新从凭据提供器取得 Cookie；跨 Origin 仅保留 Accept、Accept-Language、Content-Type 等表示头。直接 URL 模式使用精确 Origin 临时服务和按 URL 匹配的已授权 Cookie，无需固定名称名单；不绕过 Profile / Store、域、路径、Secure 或分区 Cookie 策略。
- 只读重定向改为 GET / HEAD 时，同时删除 JSON body、rawBody 和正文相关请求头；307 / 308 保留原方法与正文。
- 写/未知操作不跟随重定向，响应丢失返回 REQUEST_OUTCOME_UNKNOWN。直接 URL 请求保持 unknown 语义，不根据 HTTP 方法推断可安全重放。
- 正文流式写入目标同目录的 0600 临时文件；以硬链接原子提交，避免检查与写入之间的覆盖竞争。
- 超限或接收失败保留 `.partial` 和实际字节数；JSON 解析最多读取预算内正文。探针不落业务文件，内存预算 1 MiB。
- HTTP 状态、精确业务码类型、列表/总数/身份字段分别判断。原始业务内容可含敏感字段，默认摘要仅含 count/total/identity；raw request 成功只表示 2xx 响应已接收并保存，业务成功仍为 unknown。
- 默认 30 秒单次时限、10 MiB 正文预算、最多 5 次只读重定向；CLI 上限为 300 秒和 100 MiB。不自动分页。CLI 的 1 MiB 输入文件上限独立于响应预算。

企业代理/PAC、浏览器网络环境等价性和真实站点尚未验证，见[HTTP 规格](../../docs/07-http-and-results.md)与[开发版状态](../../docs/11-runtime-status.md)。
