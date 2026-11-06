# Intra 文档协作基线

状态：M0文档基线已推进为开发版运行时。当前源码、合成测试证据与未验收环境见[开发版状态](11-runtime-status.md)。历史intra-http实验不是运行依赖，也不是新实现的真实环境验收。

- 目标与平台：本地复用Chrome已有认证，由Node HTTP发送业务请求；首版面向macOS + Chrome MV3 + Node.js >=22，不依赖o2/WebCLI/Playwright/jd-login。
- 实现：已有CLI、Core、HTTP、Contracts、Registry、Discovery、Credentials、扩展和Native Host源码。TypeScript/ESM构建到dist，扩展使用自包含JavaScript。运行时采用AJV 2020-12和tough-cookie；Keychain通过Security.framework原生助手访问，秘密在私有stdin/stdout传递，不进argv。
- 构建：`npm ci`、`npm run build`、`npm test`。`npm run check:docs`仍可不安装依赖单独运行，只检查文档/契约子集/样例。构建不会自动加载扩展、注册宿主或调用真实业务。合成测试不代表Chrome、Keychain、企业网络与内网站点验收。
- 目录：apps/{cli,extension,native-host}；packages/{core,credentials,http,registry,discovery,contracts}；docs、schemas、examples、evidence、tests、packaging/native-host、tools。源码导航见[模块与目录](03-modules-and-layout.md)。
- 启动方向：扩展connectNative由Chrome启动宿主；CLI连接已有Unix Socket做同步。正常请求由CLI读取Keychain并执行HTTP，不依赖宿主存活。CLI不能反向唤醒扩展。当前断连后需用户重新确认，未实现自动重连。
- 本地桥安全：核对扩展来源、Profile/Store与请求范围；检查元数据、Socket和目录的所有者/权限，目录0700，元数据与Socket为0600。macOS标准Node无可用SO_PEERCRED接口，不宣称完整对端UID握手。
- 身份隔离：扩展生成随机profileId，用户确认后与友好别名显式配对；storeId不等于profileId。有可信探针时核对账号，无探针保留account-unverified。内部credentialRef没有外部按ID取密接口，CLI只输出安全元数据。
- 同步：每次限定一个URL/Store，cookieNames可选；省略时取该URL全部适用Cookie，显式非空列表要求指定名称齐全，空数组无效。自动URL快照带完整模式标记，只复用相同Origin+pathname，query换页可复用；旧名称筛选缓存不能冒充完整快照。缓存仍按Profile/Store/Service/Origin隔离；旧不可变记录暂留Keychain，无自动垃圾回收。
- 站点范围：扩展0.3.2支持自定义域（无内置预设）或用户显式全部HTTP/HTTPS网站授权。每次仍只读取目标URL适用Cookie；扩展同时验证本次选定范围与Chrome当前权限，历史宽授权不能绕过本次窄选择。宿主处理通用HTTP/HTTPS URL，业务HTTP仍限定精确Origin。全域持续同步和整仓导出未实现。
- Agent与工具职责：用户提供F12截图/复制的URL、方法、载荷及查询意图，由[调用Skill](../skills/intra-request/SKILL.md)归一化明确入参；工具不识别截图、不抓包、不推断接口或业务字段。信息齐全直接一次CLI调用，只有缺输入或失败才走诊断分支，不例行doctor/auth check/sync/登记。
- CLI：文中`intra`简写`node dist/apps/cli/src/main.js`。支持doctor、auth profiles/pair/sync/check、api register/describe/import、call。常规一次请求优先 `request --url URL --method M --profile P`，不预登记；旧 `request --service S --path PATH`仍可用。载荷选择--json、--json-file或--body-file配合--content-type，支持--query-json/--headers-json及输出预算选项；不得自动猜方法或业务参数。完整表见[规格契约](04-contracts.md)。
- doctor不读取Keychain，不调用身份探针，macOS状态为not-checked；auth check使用缓存，有探针才调用，无探针返回UNKNOWN。配对不等于账号已认证。
- Registry支持Service和Operation JSON本地登记；重复ID拒绝，仅--replace替换定义。api import只产生草稿/缺口报告，不自动登记；完整输入降为draft并去掉verifiedAt。HAR/cURL自动解析、网络观察和多平台凭据后端尚未实现；stdio MCP工具适配复用Core，见[MCP说明](../apps/mcp/README.md)。
- 契约：现有JSON Schema draft-2020-12，schemaVersion=1，格式仍为service、operation、ipc、tool-result；不因文档叙述添加未定义字段。模块函数表仅示意职责，不是逐字对应源码或稳定公共API。
- Operation：id/service/description/status/semantics/arguments/request/bindings/response/provenance。draft不可call；verified必须包含合法、非未来、带时区的verifiedAt和非空evidence引用列表，每项非空白。格式校验不代替证据审查与真实验收。
- 参数：先拒绝未知参数，再补默认值并校验类型，复制请求骨架后用JSON Pointer绑定query/body。不eval、不字符串模板转换类型；拒绝危险键、缺失目标和重叠绑定。空指针允许整体替换，但仍须满足请求规则。
- Service：id/baseUrl/auth/allowedOrigins/protocolExceptions。baseUrl为精确origin，Cookie名称不是秘密值；身份探针必须是同服务已验证只读操作。DevCloudHTTP只允许精确origin例外，不能继承到其他站点。
- HTTP：默认30秒单次HTTP时限、10MiB解码后正文预算、最多5次只读重定向；不自动分页，不支持结果文件overwrite。Secure Cookie不走HTTP，分区Cookie返回PARTITIONED_COOKIE_UNSUPPORTED，不宣称SameSite浏览器上下文等价。企业代理/PAC、CA、DNS/VPN尚未验收。
- 重定向：逐跳校验origin并重新选凭据；跨origin读取目标独立缓存，缺失则停止，不在跳转途中自动同步浏览器。Cookie/Authorization不盲转发。目标origin认证不明时不能用原origin探针推断身份。Set-Cookie仅更新当前调用，不反写Chrome或跨调用持久化。
- 恢复：raw默认semantics=unknown，不按HTTP方法猜只读。已审核read操作确认认证失效后最多刷新一次、重试一次；写/unknown请求不自动重放。403须按站点规则和适用探针分流。已发送的写/unknown请求断线或超时可能返回REQUEST_OUTCOME_UNKNOWN。
- 结果：stdout单JSON envelope，诊断只可写stderr。Operation的ok=true表示满足其HTTP、业务码和结构规则；raw是明确例外，ok=true只确认2xx响应接收并保存，data.businessSuccess=unknown。管理命令ok只表示该命令完成。data在Schema中保持通用结构。
- 输出：原始业务响应保存到文件，摘要只输出受控字段；不打印Cookie、认证头、原始异常、Set-Cookie或票据URL。超预算/接收中断报告complete=false；完整错误响应可有complete=true文件，但ok仍为false。不覆盖已有结果文件。
- 退出码：0成功；2输入/契约；3登录/Profile/桥；4权限；5网络；6业务/响应；7输出/本地运行（含KEYCHAIN_UNAVAILABLE、REFRESH_LOCK_TIMEOUT）；8请求结果未知。
- IPC：bridge.hello与cookies.snapshot已实现，双向单帧上限256KiB；Cookie响应仅在受限通道传递，不是Agent结果。credentials.resolve与http.execute仅为预留IPC名，MVP不暴露按引用取密或宿主代发HTTP；cookies.changed尚未实现。
- 历史证据：risk-api POST /link_out/autoInterfaceManage/getPageAutoInterfaceList，body含pageNo/pageSize/params，成功code字符串200、data.listResult/pageBean.totalRecord；LogWatch GET /framework/principal返回username；DevCloudHTTP GET /api-gateway/jacp-platform/api/v1/user/info?rich=false，code数字200/data.erp，未认证可HTTP200业务304。仅证明当时特定接口直接HTTP成立。
- 未知接口：getPageInterIdList只有截图，method/path/payload未知，不能套用getPageAutoInterfaceList。先收集证据；缺少必填项只能保留发现报告，不能虚构可执行Operation。chrome.webRequest不直接提供响应体。
- 文档面向初学者，区分源码实现、合成测试和真实环境验收，使用相对本地链接，不依赖绝对机器路径或外部会话。后续项只写实际尚未实现的能力，不把已实现命令标成未来规格。
