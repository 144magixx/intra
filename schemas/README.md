# 机器可读契约

状态：JSON Schema 2020-12定义与AJV运行时校验器已实现。schemaVersion仍为1；`service.auth.cookieNames`和IPC快照`cookieNames`可省略，表示按明确URL取适用Cookie，显式非空列表仍表示名称过滤且所列名称必须齐全。空数组无效，不作为全量选择的暗号。

- [service](service.schema.json)：站点根地址、允许origin和凭据规则。
- [operation](operation.schema.json)：参数、HTTP骨架、绑定、结果与证据。
- [ipc](ipc.schema.json)：内部消息外壳，以及Cookie快照类型。
- [tool-result](tool-result.schema.json)：对Agent的成功/失败结果。

[规格说明](../docs/04-contracts.md)是行为约束；Schema只能验证数据形状，不能证明权限、业务只读或接口实际可用。`arguments`内嵌Schema还需运行时单独验证，不能只验证外层operation。

内部快照响应含凭据值，绝不能当作tool-result。零依赖文档检查器验证本项目使用的Schema子集并拒绝未知关键字；运行时使用完整AJV 2020-12校验。域权限和凭据适用性在扩展/宿主/CookieJar进一步检查，schema通过不代表当前已授权。
