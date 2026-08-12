# 跨设备访问助手（后端版）

面向 Android Termux 常规路径 `~/SillyTavern` 的安全优先后端组件。它只包含 SillyTavern 服务器插件，不再作为独立前端扩展显示。

> 完整功能：检查状态、预览差异、二次确认后安全备份并修改，以及恢复最近一次助手备份。不会自动重启 SillyTavern。

## 为什么需要服务器插件

浏览器中的普通扩展不能安全地读取和写入服务器上的 `config.yaml`。服务器插件可以完成这件事，但它没有沙箱，权限与 SillyTavern 的 Node.js 进程相同。因此后端版单独发布，并保留不需要后端权限的安全版。

## 配套前端

用户只需安装主扩展：

```text
https://github.com/adelia1017/sillytavern-cross-device-access-helper
```

主扩展中的安全向导和后端功能是两个独立折叠区。后端区展开时检查一次连接，不会让安全向导消失。

请勿把本仓库地址粘贴到 SillyTavern 的“安装扩展”界面。本仓库应按主扩展给出的命令安装到 `~/SillyTavern/plugins/`。

主扩展不会自动执行安装或偷偷开启 `enableServerPlugins`。只有用户手动粘贴执行命令后，独立安装脚本才会创建备份、用 YAML 解析器验证并开启服务器插件。用户随后手动启动 SillyTavern。

服务器插件的 YAML 依赖已打包在 `dist/server-plugin.mjs`，普通用户安装时不需要运行 `npm install`。可审查的原始实现保留在 `server/` 与 `shared/`。

## 当前接口

- `GET /api/plugins/cross-device-access-helper-backend/status`
- `POST /api/plugins/cross-device-access-helper-backend/preview-change`
- `POST /api/plugins/cross-device-access-helper-backend/apply-lan-settings`
- `POST /api/plugins/cross-device-access-helper-backend/restore-latest-backup`

预览与应用接口只接受：

```json
{ "deviceIp": "192.168.123.17", "mode": "single" }
```

`mode` 只能是 `single` 或 `network`，多余字段会被拒绝。

恢复接口只接受空 JSON 对象 `{}`，不接受文件名、路径或其他参数。它只会寻找本助手创建的最近一次 `config.yaml.cross-device-access-helper-backup-*.bak`。

## 安全写入流程

1. 严格验证私有 IPv4 和固定模式。
2. 解析 `config.yaml`，拒绝无效 YAML、重复键、符号链接和错误字段类型。
3. 重新计算修改内容；后端不信任前端传来的任意字段或值。
4. 只修改 `listen`、`whitelistMode`、`whitelist`，并验证其他配置语义完全不变。
5. 独占创建临时文件、同步落盘并再次解析验证。
6. 创建带时间戳的原配置备份。
7. 再次确认操作期间原文件没有被其他程序改动，然后同目录原子替换。
8. 返回备份名并提示用户手动重启，不结束或重启 Node 进程。

任何一步失败都不会用未验证内容覆盖原 `config.yaml`。同时到来的写入或恢复操作会被串行保护，防止用户重复点击造成竞争。

## 支持范围

- 第一版：Android Termux、常规路径 `~/SillyTavern`、私有 IPv4 局域网。
- Windows、macOS、Linux 和 Docker 目前只允许查看，不开放自动写入。
- 不处理公网暴露、端口转发、隧道或 VPN 配置。

详见 [SECURITY.md](SECURITY.md)。
