# Contracts

开发版实现位于 [src/index.ts](src/index.ts)，格式源仍为 [Schemas](../../schemas/README.md)，行为依据为 [契约](../../docs/04-contracts.md)。本模块不读取凭据、不发送网络请求。

- `validate(kind, value)` 返回通过校验的值；kind 为 `service`、`operation`、`ipc`、`tool-result`、`snapshot`、`snapshotParams` 或 `hello`。使用完整 AJV2020，IPC 子类型通过本地 `$ref` 校验；未知格式和远端引用不会静默跳过。
- `projectRoot` 从 `import.meta.url` 向上寻找项目文件及 Schema，源码与保留目录结构的 dist 均不依赖调用者的 cwd。部署需要保留根目录的 Schema。
- `validateArguments(schema, args)` 要求对象参数与顶层 `properties` 显式声明的参数名；先拒绝未知输入，再向副本应用默认值并校验类型/范围，不做类型转换。嵌套结构、组合规则和本地引用由 AJV 处理。同步接口拒绝异步 Schema。
- `getPointer` / `setPointer` 实现严格 RFC6901 转义并拒绝原型危险键；只访问自身数据属性。读取不存在的字段返回 `undefined`，写入要求目标已存在，不创建父节点、不支持数组追加。空指针替换整个根，调用者须接收返回值。
- `IntraError`、`exitCodeFor` 和 `safeError` 提供分类错误；对外安全错误使用固定消息，不转发任意源错误消息、cause 或 action。
- 共享类型包括 `Service`、`Operation`、`MaterializedRequest`、`ResponseRules`、`ToolResult`、`Artifact`、`Cookie`、`CookieSnapshot` / `SnapshotResult`、`SnapshotParams` 与 `HelloParams`。JSON 边界拒绝非有限数、循环对象、访问器、稀疏数组及危险键。

[合成测试](../../tests/contracts.test.ts) 从编译后的模块执行，覆盖既有样例、完整 Schema 规则、类型保留、恶意指针、错误脱敏和不同 cwd。它们不证明任何真实登录或接口可用。
