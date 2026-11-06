# Native Host 打包（未安装、未注册）

[manifest 模板](manifest.template.json) 不能直接注册。必须填写真实 32 字符 Chrome extension ID 和可执行启动器的绝对路径。先构建 TypeScript 主机，再由用户显式调用 [generate.mjs](generate.mjs)：

```sh
node packaging/native-host/generate.mjs \
  --extension-id REAL_32_CHARACTER_EXTENSION_ID \
  --node /absolute/path/to/node \
  --host /absolute/path/to/intra/dist/apps/native-host/src/index.js \
  --output /absolute/path/to/new-staging-directory \
  --home /absolute/path/to/private-intra-home
```

生成器检查 Node 可执行、host 可读以及路径为绝对路径，拒绝已有输出目录。只生成权限 0700 的 shell 启动器和权限 0600 的 `com.intra.bridge.json`；输出文件路径，不注册、不安装、不启动 Chrome。启动器设置 `umask 077`，固定 `INTRA_EXTENSION_ID` 和 `INTRA_HOME`，通过已确定的绝对 Node 路径执行 JS，原样传递 Chrome argv。Chrome 不保证继承终端 PATH，不能把一整串命令写进 manifest path。

用户后续自行审阅后才能把注册 manifest 放入目标 Chrome 的 NativeMessagingHosts 目录。macOS 常规 Chrome 的用户目录为 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`，不同 Chrome 产品/企业策略需单独核实；路径指向的 staging 启动器必须继续存在。实际扩展 ID 必须同时匹配 manifest 的 allowed_origins 和启动器的 expected ID；不使用通配符，不根据扩展自己报送的身份决定信任。

本轮仅合成测试生成器；未注册 Native Host，未安装扩展，未读取真实浏览器 Cookie。安全与 macOS peer-UID 限制见 [主机说明](../../apps/native-host/README.md)。
