# 验证证据

[Risk API第10页成功记录](intra-e2e-risk-api-page10-success-2026-11-05.json)记录2026-11-05 21:44（Asia/Shanghai）的真实请求：HTTP200、业务码字符串200、第10页10条、总数589，以及后续独立进程Keychain缓存读取成功。不包含Cookie值或原始业务正文，只覆盖这一个只读请求。

[本项目首次 Risk API 端到端测试](intra-e2e-risk-api-2026-11-05.json)记录2026-11-05真实Chrome连接、Profile配对和Cookie快照请求。首次同步返回COOKIE_NOT_FOUND，实际接口路径快照也返回0条匹配Cookie；尚未进入Keychain存取或业务HTTP。源码核对发现共享域Cookie权限缺口，这条记录只表示当时的失败阶段；后续成功由上方独立记录说明。

## 历史实验

[最终验证](final-verification.json)及[单项对照](minimal-auth.json)来自2026-11-04的本地HTTP实验。值级Cookie未落盘；实验先用WebCLI读取浏览器凭据，再由Node发业务请求。

这些证据只证明相应凭据和接口当时可用，不证明本项目自有扩展已运行、自动刷新可行、全站权限或性能SLA。实验账号信息属于当前用户，未作为可执行配置默认值。

详细边界在 [证据与决策](../docs/09-evidence-and-decisions.md)。
