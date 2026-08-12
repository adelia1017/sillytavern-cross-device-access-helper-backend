# 权限、隐私与威胁模型

服务器插件没有沙箱，会继承 SillyTavern Node.js 进程的文件系统和网络权限。仅在审查并信任源码后安装。

## 允许的行为

- 固定读取 SillyTavern 根目录的 `config.yaml`。
- 从配置中使用 `listen`、`whitelistMode`、`whitelist`，并只读端口以生成访问地址。
- 使用 Node.js 的本机网络接口信息识别私有局域网 IPv4。
- 接收严格的 `{ deviceIp, mode }` 请求；`mode` 只能是 `single` 或 `network`。
- 在 Android Termux 常规路径中，二次确认后只修改 `listen`、`whitelistMode`、`whitelist`。
- 创建本助手专用备份，并且只恢复最近一次本助手备份；恢复前再备份当前配置。

## 明确禁止

- 不接受用户指定的文件路径、配置字段或任意值。
- 不读取或修改聊天、角色卡、世界书、预设和密钥。
- 不修改端口、认证、CSRF、`securityOverride` 或 `enableServerPlugins`。
- 不执行 Shell、子进程或自动重启；不连接外部服务器；无遥测。
- 不删除 SillyTavern 数据。

## 写入功能边界

运行中的写入接口只接受严格的设备 IP 和固定模式，不接受路径、字段名或任意 YAML 值。恢复接口不接受任何参数。写入只在 Android Termux 的 `~/SillyTavern` 开放；检测到自定义配置路径、符号链接、重复 YAML 键或 `whitelist.txt` 覆盖时会拒绝应用。

配置先写入同目录临时文件并再次解析验证，再创建备份并原子替换。操作期间若原配置被其他程序修改，会放弃替换。后端不会修改 `enableServerPlugins`、端口、认证、CSRF 或 `securityOverride`，也不会自动重启。

### 关于首次启用服务器插件

运行中的后端接口永远不允许修改 `enableServerPlugins`。前端只显示安装命令，不会执行它。

仓库包含一个由用户在 Termux 中明确手动运行的独立安装脚本 `scripts/enable-server-plugins.mjs`。它的唯一配置修改是把 `enableServerPlugins` 设为 `true`，并且仅支持固定路径 `~/SillyTavern/config.yaml`。修改前会拒绝符号链接、无效 YAML 和重复键，创建带时间的备份，经临时文件再次解析验证后才原子替换。它不启动或重启 SillyTavern。

检测到 `whitelist.txt` 时，后续自动写入也必须保持禁用，因为 SillyTavern 当前会优先使用该文件并覆盖 `config.yaml` 的白名单。
