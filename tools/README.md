# 本地文档校验

[check-docs.mjs](check-docs.mjs)是零依赖Node脚本，可用 `npm run check:docs` 单独运行，无需先安装项目依赖。

检查JSON可解析、Markdown本地链接、当前Schema子集、examples索引、绑定参数与目标、证据路径、只读身份探针、HTTP例外和负向样例。不会打开浏览器、访问网络或读取钥匙串。

运行时契约已经使用AJV 2020-12，Cookie匹配使用tough-cookie；文档检查器没有因此增加依赖，也不冒充完整AJV校验。开发构建与合成测试使用 `npm ci`、`npm run build`、`npm test`。

限制：不渲染Mermaid、不验证外部URL可用性、不证明运行时集成、Chrome/Keychain/企业环境验收或接口最新状态。当前证据见[开发版状态](../docs/11-runtime-status.md)。
