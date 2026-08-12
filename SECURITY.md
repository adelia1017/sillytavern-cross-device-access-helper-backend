# 权限、隐私与威胁模型

服务器插件没有沙箱，会继承 SillyTavern Node.js 进程的文件系统和网络权限。仅在审查并信任源码后安装。

## 允许的行为

- 固定读取 SillyTavern 根目录的 `config.yaml`。
- 从配置中使用 `listen`、`whitelistMode`、`whitelist`，并只读端口以生成访问地址。
- 使用 Node.js 的本机网络接口信息识别私有局域网 IPv4。
- 接收严格的 `{ deviceIp, mode }` 请求；`mode` 只能是 `single` 或 `network`。

## 明确禁止

- 不接受用户指定的文件路径、配置字段或任意值。
- 不读取或修改聊天、角色卡、世界书、预设和密钥。
- 不修改端口、认证、CSRF、`securityOverride` 或 `enableServerPlugins`。
- 不执行 Shell、子进程或自动重启；不连接外部服务器；无遥测。
- 不删除 SillyTavern 数据。

## 当前开发阶段

`0.1.0-dev.1` 只有状态读取和修改预览。写入、备份和恢复接口固定返回 501，不会改动文件。

检测到 `whitelist.txt` 时，后续自动写入也必须保持禁用，因为 SillyTavern 当前会优先使用该文件并覆盖 `config.yaml` 的白名单。
