# Intra 项目开发约束

## 分支与合并（必须遵守）

- 开发新功能、修缺陷、重构，以及改契约/Schema/工具行为，必须先从最新 `main` 新建分支：功能用 `feat/<简述>`，修复用 `fix/<简述>`，其余用 `chore/<简述>`。不在 `main` 上直接开发或提交。
- 开发时遵守本文件其余约束：代码、Schema、样例、文档、测试同步更新，提交信息沿用 `feat:`/`fix:`/`chore:` 前缀。
- 合并前要满足：`npm test` 全部通过、`npm run check:docs` 通过、`git status` 没有误带生成物或凭据（例如 `apps/extension/manifest.json`、`outputs/`），并向用户汇报改动和验证范围。合成测试和真实验收要分开说明。
- 只有确认没问题后才合并回 `main`，用 `git merge --no-ff` 保留分支记录。合并后在 `main` 上重新 `npm run build`，再删除本地分支。不 force push，不改写 `main` 历史。
- DSH 的 `mcp-intra` 运行的是工作区 `dist/` 里的产物：在分支上 build 会让正在使用的 MCP 工具跑分支代码。需要真机验证时向用户说明；合并或放弃分支后，回到 `main` 重新 build。
- 只改文档措辞、或用户明确要求的紧急小修，可以经用户同意后例外处理，并在汇报中说明。

- 先读 [入口](README.md)、[设计基线](docs/design-baseline.md)、[契约](docs/04-contracts.md)。当前为开发版运行时；具体实现与未验证项见 [状态](docs/11-runtime-status.md)，不把合成测试说成真实环境验收。
- 新工具不得依赖o2/WebCLI/Playwright/jd-login；evidence仅为历史实验来源。不要搬入真实Cookie、Token或带认证的HAR/cURL。
- CLI进程直接读取Keychain并执行HTTP；NativeHost仅在浏览器同步时使用。凭据不走Agent stdout，内部credentialRef不可跨进程猜取。
- operation未知参数必须保留未知。getPageInterIdList不得套用getPageAutoInterfaceList定义。
- 更新接口必须同步Schema、样例、文档和验证；JSON Pointer按类型映射，不eval。
- 任何403不自动等于过期，任何HTTP200不自动等于业务成功，任何POST不自动等于写操作；采用已验证站点规则。
- 未知/写请求不盲重放；跨origin重新匹配凭据；分区Cookie不能当普通Cookie。
- 真实接口验证须注明时间、范围和当前实现来源。优先合成测试，不将文档校验说成运行时集成验收。
- Node.js >=22；本地运行时使用 `npm ci`、`npm run build`、`npm test`。`npm run check:docs` 仍可不安装依赖单独执行，只检查文档/契约/样例。不修改已有Digger工程。
- Runtime契约使用AJV 2020-12，Cookie匹配使用tough-cookie；verified定义须有合法非未来verifiedAt与非空evidence引用，不能把格式校验当实测。
- raw request的ok=true只表示响应接收并保存，data.businessSuccess为unknown；与operation的业务成功契约区分。
- 构建不自动加载扩展或注册宿主；doctor不读Keychain（macOS为not-checked）。Socket目录/元数据/端点做所有者与权限检查，不声称macOS标准Node已实现完整peer UID握手。
- 用户提供接口截图、URL、方法、载荷和查询意图时，使用项目级 [intra-request Skill](skills/intra-request/SKILL.md)。识别材料、归一化业务参数由Agent完成；工具仅执行明确请求，不新增截图识别、自动抓包、接口发现或业务参数推断。
- 用Intra工具（MCP或CLI）无法完成用户指令、或用户提供信息不完整时，停下来向用户询问缺口；不得改用浏览器操作、o2/WebCLI、jd-login、企业CLI等其他手段，除非用户明确指定。
- 普通取数走单次CLI快速路径：信息齐全且Profile已确认时直接 `request --url` 或已知Operation的 `call`。不例行运行doctor/auth check/auth sync/register/describe、不重复构建测试；仅在缺输入或失败时进入相应分支。
- 扩展0.3.0支持按域授权或用户显式选择全部HTTP/HTTPS网站。Cookie名称可省略，表示当前URL适用Cookie；仍禁止全浏览器仓库导出、Agent明文凭据和跨站盲转发。自动URL模式缓存只保证原origin+pathname的完整性。
