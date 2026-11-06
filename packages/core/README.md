# Core

实现见 [index.ts](src/index.ts)：协调 Registry、Credentials 和 HTTP，返回统一 ToolResult。CLI 和浏览器适配器通过依赖注入接入。

已知操作按契约校验参数、取得缓存后执行；只有缺少缓存或已确认认证失效时才同步。只读恢复在刷新锁内重读 generation；同值快照停止恢复，最多一次刷新和一次重放。raw 请求保持 unknown 语义，写请求不自动重试。

403/401 根据已配置且只读的身份探针分流；无可信判据返回 AUTH_STATE_UNDETERMINED，探针通过返回 FORBIDDEN。同步时先用快照探测身份，再保存；无探针的服务标记 account-unverified。

`requestURL(url, request, options)` 接收已明确的URL/方法/query/headers/JSON或原始正文，创建仅当前Origin的临时Service，无需登记、不发身份探针、不做截图识别或业务参数推断。Cookie名称省略时使用完整URL模式：缓存按Origin隔离并检查原pathname，query变化可复用，路径变化需重新同步；同一次调用中也按Origin+pathname选择会话。

显式同步的URL模式若配置了不同路径的身份探针，会为探针单独取得快照，身份核对后保存业务URL快照。普通失败分流遇到缺少完整探针路径时返回身份不确定，不误判登录过期。

`auth check` 无探针返回 UNKNOWN，不替用户选择业务接口。普通请求不例行调用它。真实浏览器与Keychain验证边界见[开发版状态](../../docs/11-runtime-status.md)。
