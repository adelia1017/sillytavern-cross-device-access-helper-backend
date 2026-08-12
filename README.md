# 跨设备访问助手（后端版）

面向 Android Termux 常规路径 `~/SillyTavern` 的安全优先后端组件。它只包含 SillyTavern 服务器插件，不再作为独立前端扩展显示。

> 当前为 `0.1.0-dev.1` 只读开发版：只能检查状态和预览差异，不能修改或恢复配置。

## 为什么需要服务器插件

浏览器中的普通扩展不能安全地读取和写入服务器上的 `config.yaml`。服务器插件可以完成这件事，但它没有沙箱，权限与 SillyTavern 的 Node.js 进程相同。因此后端版单独发布，并保留不需要后端权限的安全版。

## 配套前端

用户只需安装主扩展：

```text
https://github.com/adelia1017/sillytavern-cross-device-access-helper
```

主扩展默认显示完整安全命令模式；用户点击“安装后端组件，切换为自动配置”后才会看到风险说明和安装命令。后端连接成功时，同一个主扩展面板自动切换为后端模式。

请勿把本仓库地址粘贴到 SillyTavern 的“安装扩展”界面。本仓库应按主扩展给出的命令安装到 `~/SillyTavern/plugins/`。

主扩展不会自动执行安装或偷偷开启 `enableServerPlugins`。只有用户手动粘贴执行命令后，独立安装脚本才会创建备份、用 YAML 解析器验证并开启服务器插件。用户随后手动启动 SillyTavern。

服务器插件的 YAML 依赖已打包在 `dist/server-plugin.mjs`，普通用户安装时不需要运行 `npm install`。可审查的原始实现保留在 `server/` 与 `shared/`。

## 当前接口

- `GET /api/plugins/cross-device-access-helper-backend/status`
- `POST /api/plugins/cross-device-access-helper-backend/preview-change`
- `POST /api/plugins/cross-device-access-helper-backend/apply-lan-settings`（当前固定 501）
- `POST /api/plugins/cross-device-access-helper-backend/restore-latest-backup`（当前固定 501）

预览接口只接受：

```json
{ "deviceIp": "192.168.123.17", "mode": "single" }
```

`mode` 只能是 `single` 或 `network`，多余字段会被拒绝。

## 支持范围

- 第一版：Android Termux、常规路径 `~/SillyTavern`、私有 IPv4 局域网。
- Windows、macOS、Linux 和 Docker 目前只允许查看，不开放自动写入。
- 不处理公网暴露、端口转发、隧道或 VPN 配置。

详见 [SECURITY.md](SECURITY.md)。
