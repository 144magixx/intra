# Discovery

开发版离线定义导入位于 [src/index.ts](src/index.ts)。`importDefinition(value)` 返回 `{ draft?, missing, source }`，不会保存定义或发请求；CLI 可把结果交给用户补证后再登记。

完整 operation 输入会复制为 draft，清除 `provenance.verifiedAt` 并保留来源和证据；不会按 HTTP 方法推断或提升 read/write/unknown 语义。缺少 method、path、参数定义、成功条件等必需事实时，仅返回固定字段名组成的缺失报告，不构造可执行占位定义，不把未知接口套用到相似名称的已知接口。

导入器拒绝认证/代理/Host 等禁止的请求头，以及 URL 用户名密码、query/body/参数定义中常见名称的认证字段；错误不会包含提交值。字段名检查无法证明任意业务数据不含秘密，导入材料仍须人工审查。MVP 不解析原始 cURL、HAR、OpenAPI，不自动观察浏览器请求。

[发现流程](../../docs/05-request-discovery.md) 说明证据边界；[合成测试](../../tests/discovery.test.ts) 覆盖 draft 降级、缺失事实、未推断语义、认证字段与原型输入。测试不包含生产登录或真实请求。
