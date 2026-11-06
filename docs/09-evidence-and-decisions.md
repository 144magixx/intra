# 09 · 已验证事实、设计决策与未知项

读技术方案时最容易混淆“能做”“做过实验”“产品已实现”。本项目严格区分三者。

## 当前成熟度

- **已验证实验**：2026-11-04，借助已有WebCLI浏览器桥取Cookie后，由本机Node直接发HTTP，三个指定接口认证成功。
- **当前项目交付**：开发版 CLI/Core、契约/登记/发现、HTTP、凭据与浏览器桥，以及合成测试；证据见[开发版状态](11-runtime-status.md)。
- **尚未验收**：真实 Chrome 安装、宿主系统注册、真实 Keychain 读写、企业网络与内网站点。
- **尚未实现**：增量同步、自动 HAR/cURL 解析、浏览器请求观察、多平台凭据后端。stdio MCP 工具适配已于2026-11-06加入，见[MCP说明](../apps/mcp/README.md)。

实验依赖WebCLI只是证据来源；新项目运行时不依赖o2/WebCLI。自有扩展已有源码，仍需真实环境验收，不能把历史结果当作独立工具验收结果。

## 实测证据

见 [最终组合验证](../evidence/final-verification.json)、[单项凭据对比](../evidence/minimal-auth.json)。这些文件不含Cookie值；用户名属于当时的账号身份信息。

| 接口 | 已知事实 | 范围限制 |
|---|---|---|
| Risk API POST `/link_out/autoInterfaceManage/getPageAutoInterfaceList` | `sso.corp.example`可用，返回code字符串200及列表；两Cookie组合也成功 | 只读配置化列表；不证明所有写接口可用 |
| LogWatch GET `/framework/principal` | `uas_jtoken`可用，返回当前用户；SSO-only曾403 | 身份接口，不证明某应用日志权限 |
| DevCloudHTTP GET `/api-gateway/jacp-platform/api/v1/user/info?rich=false` | `sso.corp.example`可用，返回code数字200及ERP；无凭据时HTTP200业务304 | 身份接口，不证明DeepTest执行或部署权限 |

两项Cookie都来自`.corp.example`共享域。对上述接口，使用同一组`sso.corp.example`+`uas_jtoken`值成功；不代表该公司所有站点使用相同认证。

证据中的Cookie expiry只是浏览器元数据，不保证服务端到期前一直接受。Session Cookie无明确expiry也不等于永久有效。没有测试自动续期或跨机器复用。

## 两个容易混淆的列表接口

| 名称 | 当前状态 |
|---|---|
| getPageAutoInterfaceList | 完整路径、POST、部分分页参数和返回结构已通过HTTP实验验证；已有可执行定义样例 |
| getPageInterIdList | 用户截图中的普通接口管理列表；可见接口名和返回结构，但完整URL、method、Payload未取证 |

因此本项目没有给getPageInterIdList编造可执行定义。截图中849条只是当时页面总数；历史Auto接口589条也是当时的数据，不写成永久断言。

后续要登记Inter接口，先从文档/源码/真实请求获取契约，再验证。不要复制Auto的路径和请求体改个名字。

## 已做的架构决策

| 决策 | 原因 | 代价/替代 |
|---|---|---|
| 自有扩展读Cookie | 官方API支持HttpOnly，避免依赖页面或解密数据库 | 首次需安装扩展、授予目标站点权限 |
| Native Messaging桥接 | Chrome限定扩展ID，与普通网页隔离 | 配置原生宿主与绝对可执行路径 |
| CLI本进程执行HTTP | 缓存有效时不依赖Chrome和宿主存活 | 每次CLI启动有固定开销 |
| Keychain持久化 | 跨调用复用且不把秘密放源码/环境文件 | 先支持macOS，锁定与访问控制需处理 |
| JSON定义+JSON Pointer绑定 | 可校验、无eval、容易导入与维护 | 复杂动态签名需要独立适配器 |
| 查询不自动全量分页 | 避免一次小任务变成大量请求 | 用户需明确范围 |
| MVP不支持分区Cookie重放 | 原生HTTP缺少顶层站点上下文 | 返回明确不支持，后续适配 |
| first sync快照，增量后置 | 降低首次复杂度 | 浏览器变化需要手动/按需重新同步 |

## 真实环境验收与后续工作

1. Node HTTP网络与浏览器网络差异：企业代理/PAC、证书、DNS/VPN。
2. macOS Keychain已采用Security.framework原生助手，通过私有stdin/stdout传输秘密，不用argv；真实访问授权、锁定和部署环境仍待验收。
3. 扩展打包与稳定ID：开发加载与正式签名的ID不同，allowed_origins需同步。
4. Chrome版本、MV3生命周期与长连接行为；当前没有自动重连，断连后需重新确认，不能只凭进程存在判断连接可用。
5. uas_jtoken签发与刷新机制、SSO服务票据兑换方式；当前不能承诺自动签发。
6. 新站点是否需要CSRF、Bearer、动态签名、设备证明；Cookie-only不是万能路径。
7. request观察功能是否使用webRequest、DevTools或debugger，各自权限与响应体能力不同。

## 设计依据

- [Chrome Cookies API](https://developer.chrome.com/docs/extensions/reference/api/cookies)：Cookie属性、Store、变化事件与分区信息。
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)：连接启动方向、注册与长度前缀协议。
- [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)：请求观察能力边界，不等于完整响应体抓取。
- [JSON Pointer RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)：字段绑定与结果提取语法。
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)：机器可读契约格式。

以上官方链接是设计依据，当前实现和测试证据见[开发版状态](11-runtime-status.md)。2026-11-05真实测试确认浏览器桥连通，但所需Cookie匹配为空；核对[Chromium Cookie过滤代码](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/api/cookies/cookies_helpers.cc)发现旧版子域权限会漏掉共享父域Cookie。按用户多站点需求，0.2.0统一授权corp.example根域和子域，业务HTTP仍受Service精确allowedOrigins约束。更新后仍待用户重载和授权，再验证第10页查询，详见[端到端记录](../evidence/intra-e2e-risk-api-2026-11-05.json)。Set-Cookie仅作用于当前调用，旧不可变Keychain快照没有自动垃圾回收。
