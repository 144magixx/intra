# 样例说明

[索引](index.json)登记每份样例对应的Schema，`npm run check:docs`离线验证。

services和operations中的Risk API/LogWatch/DevCloud定义基于已知历史事实，开发版运行时已实现。[通用站点](services/generic-web.json)和[URL快照请求](messages/url-snapshot-request.json)使用保留的example.test域名，纯属合成示例，展示省略Cookie名称时自动匹配URL的契约，不代表已验证的网站或真实接口。messages中的时间、延迟、文件路径和Cookie值均为合成示例。operation.status=verified表示历史接口依据，不代表此项目已通过真实接口集成测试。

[共享父域快照请求](messages/shared-domain-snapshot-request.json)展示0.2.0支持非硬编码子域的协议形式。`example-service.corp.example/api/example`是纯合成地址，不是已验证的真实服务；该消息只请求Cookie快照，不执行业务HTTP。IPC字段和schemaVersion仍为1，域范围由扩展和宿主的运行时策略校验。

不把真实Cookie替换进快照样例。没有getPageInterIdList的可执行样例，因为请求路径/方法/Payload未核实。参见 [发现流程](../docs/05-request-discovery.md)。
