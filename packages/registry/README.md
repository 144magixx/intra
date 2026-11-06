# Registry

开发版实现位于 [src/index.ts](src/index.ts)，负责 service / operation 的本地保存、语义检查及请求组装，不执行远端请求。格式与行为依据分别为 [操作 Schema](../../schemas/operation.schema.json) 和 [发现与登记](../../docs/05-request-discovery.md)。

`new Registry(root)` 使用 `root/services/<id>.json` 与 `root/operations/<id>.json`。`register(definition, { replace? })` 自动识别定义种类并返回 `{ id, kind }`；`registerFile(path, options)` 读取 JSON 文件后执行同一流程。默认通过临时文件加原子硬链接提交，已有 ID 返回 `REGISTRY_CONFLICT`；明确 `replace: true` 才原子替换。新文件权限为 0600、新目录为 0700；路径安全 ID、目录检查及不跟随文件符号链接限制意外越界。读取文件上限为 1 MiB。

`getService(id)` / `getOperation(id)` 每次加载并重新校验定义。`resolve(id, args)` 返回 `{ service, operation, request }`：draft 不可调用；服务配置了身份探针时，探针必须同服务、verified、read、有身份指针，且能以空业务参数组装。登记可先于关联定义；关联关系在 resolve 时检查。

`materialize(service, operation, args)` 拒绝未知参数、补默认值并按原有 JSON 类型写入请求副本。绑定目标必须存在，重复及祖先/子节点重叠绑定均拒绝；空指针允许独立覆盖整个 query/body 根。query 仅接受字符串、布尔和数字，用 URLSearchParams 编码；数组、对象、null 及 path/query 同名冲突不隐式拼接。

`validateRequest(service, request)` 返回最终 URL。baseUrl 和 allowedOrigins 必须是规范化的精确 origin；每个 HTTP origin 单独配置非空理由的例外。方法只允许协议规定的七种；拒绝跨 origin 路径、反斜杠、控制字符、fragment 及转义后的 origin 注入。调用方提供的 url 必须与最终组装结果完全一致。GET/HEAD 不接受 body。认证头、Host、代理和传输控制头及易混淆的重复头不能进入定义；这些约束不会自动授予信任或把 GET 推断为只读。

verified 定义必须带合法、非未来的带时区验证时间及非空证据引用。这里检查证据结构，不替代人工审核，也不会把导入状态自动提升为可信验证。

[合成测试](../../tests/registry.test.ts) 覆盖 typed bindings、URL/头策略、并发不覆盖登记、替换、文件损坏、符号链接、探针关联以及全部历史样例的离线组装；没有真实 HTTP 或凭据访问。
