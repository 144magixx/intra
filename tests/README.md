# 合成运行时测试与验收边界

在Node.js >=22下运行：

```bash
npm ci
npm run build
npm test
```

`npm test` 会先构建，再运行Node测试。当前已有CLI/Core、AJV契约、登记/发现、HTTP、凭据与浏览器桥的合成测试；使用假Cookie、内存凭据存储或原生调用替身、本地模拟HTTP、模拟Chrome API/Native Messaging及临时目录。具体覆盖和最近执行证据见[开发版状态](../docs/11-runtime-status.md)，不在此固定通过数量。

[fixtures](fixtures/README.md)仅含无秘密的合成响应。测试用于检查类型、错误分类、超时、重试上限、文件预算、Cookie隔离和输出泄漏等行为，不代表真实Chrome加载、系统宿主注册、真实Keychain访问或企业网络/内网站点验收。

`npm run check:docs` 可不安装依赖单独运行，只检查文档、Schema子集和样例，不能替代运行时测试。完整验收目标见[构建与验收](../docs/08-build-and-acceptance.md)，未执行的真实环境项目保持未执行。
