# 跨设备访问助手（高级版）

面向 Android Termux 常规路径 `~/SillyTavern` 的安全优先高级版。它由同一仓库中的前端扩展和 SillyTavern 服务器插件组成。

> 当前为 `0.1.0-dev.1` 只读开发版：只能检查状态和预览差异，不能修改或恢复配置。

## 为什么需要服务器插件

浏览器中的普通扩展不能安全地读取和写入服务器上的 `config.yaml`。服务器插件可以完成这件事，但它没有沙箱，权限与 SillyTavern 的 Node.js 进程相同。因此高级版单独发布，并保留不需要后端权限的安全版。

## 第 0 步不是隐藏前提

前端启动后会主动检查后端：

- 响应正常：显示当前配置、安卓局域网地址和预览界面。
- 无响应：显示“服务器插件未安装或未启用”，并进入安装向导。

前端不会尝试偷偷开启 `enableServerPlugins`。正式测试版会给 Android Termux 用户提供一整段可复制、创建备份并用 YAML 解析器验证的安装命令；用户执行后只需手动重启一次 SillyTavern。

## 当前接口

- `GET /api/plugins/cross-device-access-helper/status`
- `POST /api/plugins/cross-device-access-helper/preview-change`
- `POST /api/plugins/cross-device-access-helper/apply-lan-settings`（当前固定 501）
- `POST /api/plugins/cross-device-access-helper/restore-latest-backup`（当前固定 501）

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
