# 10 · 跟着一次查询看完整输入输出

本章把前面概念串起来，面向没写过CLI的新手。下面命令已有开发版入口，构建后用 `node dist/apps/cli/src/main.js` 替代 `intra`；真实内网流程仍需安装、授权和验收。我们使用真正有HTTP证据的`getPageAutoInterfaceList`，不会把截图中尚未取证的`getPageInterIdList`补成虚构接口。

## 0. 首次接入：先知道接口怎么调

Agent从文档、源码或真实请求确认URL、方法、参数和结果；整理为 [配置化列表定义](../examples/operations/risk-api.auto-interfaces.list.json)。已有证据说明它是POST只读查询，参数包含pageNo/pageSize/params，返回code字符串200和data.listResult。

先在Node.js >=22下运行 `npm ci`、`npm run build`；合成测试为 `npm test`，零依赖文档检查为 `npm run check:docs`。具体执行证据见[开发版状态](11-runtime-status.md)。

本地登记服务与操作，示例不会自动装入登记库：

```bash
intra api register --file examples/services/risk-api.json
intra api register --file examples/operations/risk-api.auto-interfaces.list.json
intra api describe risk-api.auto-interfaces.list
```

登记是本地保存定义，不发送业务请求，不修改服务端。重复ID默认报错，只可显式--replace替换定义；api import --file仅返回draft/missing/source报告，不自动登记。verified定义须含有效非未来的verifiedAt与非空evidence引用。完整流程见[接口发现](05-request-discovery.md)。

真实请求还需按[宿主交付说明](../packaging/native-host/README.md)准备扩展和宿主；构建不会自动安装。用户在目标Chrome Profile登录并在扩展确认授权连接后，执行：

```bash
intra doctor
intra auth profiles
intra auth pair --profile work --profile-id PROFILE_ID --store STORE_ID
intra auth sync --service risk-api --profile work
```

PROFILE_ID与STORE_ID替换为已连接扩展的实际值；仅一个Store时可省略--store。doctor不读取Keychain，macOS显示not-checked。Risk API没有独立身份探针，auth check返回UNKNOWN；同步成功也不能声称账号已由探针核对。当前示例是操作步骤，不是新运行时已完成真实内网验收的记录。

## 1. 用户说“查第一页，10条”

Agent根据describe返回的参数说明，调用开发版命令：

```bash
intra call risk-api.auto-interfaces.list --profile work \
  --args-json '{"page":1,"pageSize":10}' --output ./interfaces.json
```

工具入口解析出：

```json
{"operationId":"risk-api.auto-interfaces.list","profile":"work","args":{"page":1,"pageSize":10},"output":"./interfaces.json"}
```

它不包含Cookie。`work`是用户配对的别名，不是Chrome自动猜出的业务账号。

## 2. Registry把参数填到正确位置

输入是operationId与args。输出是明确的HTTP请求，以及只读、结果提取规则。bindings把page写入body的`/pageNo`，把pageSize写入`/pageSize`，数字类型不变。

```json
{
  "method":"POST",
  "url":"https://risk-api.corp.example/link_out/autoInterfaceManage/getPageAutoInterfaceList",
  "body":{"pageNo":1,"pageSize":10,"params":{"likeKey":"","valid":"","type":"","protocol":"","onlineType":""}},
  "semantics":"read"
}
```

非法page="abc"在本地就失败，不触发浏览器同步和网络请求。服务允许的最大pageSize未确认，不能把任意大值当作经过验证的用法。

## 3. Credentials选择身份

输入为Profile别名、服务与目标URL，服务定义指定Cookie名`sso.corp.example`。缓存存在且适用时，凭据模块返回进程内会话，HTTP通过该会话按URL取用Cookie。内部credentialRef只是标识，没有外部按ID解析秘密的入口。

会话元数据中的expiresAt=null不是永久有效，也不是CLI结果的固定字段。auth sync对外只报告Profile、Cookie名称、accountVerified、last-observed状态和browser来源，不输出凭据引用或值。

缓存缺失时，CLI通过Socket向Native Host请求快照；Native Host把请求转给扩展。扩展读Cookie并返回，CLI校验后原子存Keychain。内部消息可直接看 [请求](../examples/messages/snapshot-request.json) 与 [响应](../examples/messages/snapshot-response.json)。

浏览器扩展只能同步已有值；没有Cookie或浏览器里的会话也失效，需要用户完成对应站点登录。不能凭空签发身份。

## 4. HTTP客户端真正联网

它通过进程内会话按目标URL选择Cookie，并组装请求头；不存在给外部调用者的credentialRef解密接口：

```http
POST /link_out/autoInterfaceManage/getPageAutoInterfaceList HTTP/1.1
Host: risk-api.corp.example
Content-Type: application/json
Cookie: sso.corp.example=<仅在进程内部出现的值>
```

正文来自步骤2。业务请求不经Chrome；Chrome关闭、宿主退出，也不影响已缓存且仍有效的凭据被本机HTTP客户端使用。

HTTP模块内部返回状态、解析结果、受控临时正文路径、字节数和耗时，Core再分类和提交文件。原始Cookie和Set-Cookie不进入Agent输出；这些内部字段也不是稳定公共API。

## 5. 分类器判断成功

依次检查：有无网络错误；是否明确跳转登录；HTTP是否200；正文是否JSON；`code`是否字符串"200"；`data.listResult`是否数组；`data.pageBean.totalRecord`是否符合预期。

如果拿到HTML登录页，即使HTTP200也不成功。如果业务结构变了，返回RESPONSE_SCHEMA_MISMATCH，不把缺失字段当空列表。

## 6. Output保存与摘要

实际业务响应完整保存在指定文件，小摘要送回Agent。示例见 [success-result.json](../examples/messages/success-result.json)。

摘要里count是本次条数，total是接口声称的总量；两者不相等时不表示自动翻页。示例的589来自历史记录，运行时必须读真实值。示例耗时与文件字节数是合成展示，不是本项目性能成绩。

输出文件存在则报OUTPUT_EXISTS，没有overwrite选项，必须换路径。默认预算10 MiB、单次HTTP时限30秒，可用--max-bytes和--timeout-ms调整；响应超预算时报告不完整，不把截断正文当成完整JSON。

若使用raw request而不是operation，ok=true仅代表响应接收并保存；data.businessSuccess为unknown，不代表通过上面的业务规则。已知方法/路径可以用 `intra request --service risk-api --profile work --method POST --path PATH --json JSON --output RESULT_PATH`，但raw未知语义不自动重放，不能靠POST/GET猜只读。

## 7. Agent拿到结果后做什么

它可以直接回答条数，或按任务读取文件的相关字段，形成表格。完整原文无需每次全部进入模型上下文。用户要继续第二页，Agent再调用相同operation并传page=2。

## 登录失效时多出来的分支

```text
原请求 → 已登记的SSO登录跳转
    → AUTH_EXPIRED
    → 同一身份单飞同步一次
    → 新Cookie + 已知只读查询 → 最多重放一次
    → 仍失败或值没有更新 → LOGIN_REQUIRED
```

401/403没有可靠证据时先分流，不一律重登。写请求响应丢失必须考虑已经执行，不能照搬只读查询的重试。

## 如果换成截图里的getPageInterIdList

Registry找不到已验证操作，返回OPERATION_NOT_FOUND或OPERATION_UNVERIFIED。下一步是补齐真实请求证据，而不是拿Cookie后猜一个URL。只有定义核实之后，步骤2到6才能自动化。

这也解释本工具的边界：它能让“已知如何调用的接口”变得稳定快速；“未知接口怎么调”仍要通过独立的发现过程获得事实。
