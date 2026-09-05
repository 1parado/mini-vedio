# mini-vedio

极简的点对点加密音视频通话应用 —— 单文件 exe，双击即用。

![平台](https://img.shields.io/badge/platform-Windows-blue) ![体积](https://img.shields.io/badge/exe-~12MB-success) ![加密](https://img.shields.io/badge/media-DTLS--SRTP-orange)

## 特性

- **双击即用**：无需安装，系统自带 WebView2 即可运行
- **局域网直连**：同一 WiFi/路由器下自动发现设备，一键呼叫
- **跨网通话**：邀请码二段式交换，经公共 STUN 打洞 P2P 直连（无需任何服务器）
- **全程加密**：媒体走 WebRTC 强制的 DTLS-SRTP；SAS 核对码人工比对，防信令中间人
- **纯语音模式**：无摄像头设备自动降级；文字消息经 DataChannel 点对点传输
- **本地工具**：通话记录与联系人仅保存在本机，可随时清空
- **可诊断**：帮助菜单可导出不含 SDP/邀请码正文的诊断日志

## 使用

| 场景 | 操作 |
|---|---|
| 局域网通话 | 双方运行 exe，首页「附近的设备」点击即呼 |
| 跨网通话 | 一方「创建新通话」→ 邀请码私聊发给对方 → 对方粘贴并回传回复码 |
| 手机参与 | 电脑运行 `mini-vedio.exe serve`，手机浏览器（同 WiFi）打开打印的地址，加载后切蜂窝流量即可跨网通话 |
| 手机装成 App | 前端已 PWA 化：托管 `frontend/dist` 后手机浏览器「添加到主屏幕」即可全屏使用；可再用 PWA/TWA 打包成 APK（见 [docs/android-packaging.md](docs/android-packaging.md)） |

> 手机端（浏览器/PWA/APK）没有局域网自动发现（浏览器无 UDP 权限），跨网通话走邀请码模式。

> 首次运行如出现 Windows 防火墙提示，请允许（局域网发现需要 UDP）。

## 构建

依赖：Go 1.24+、Node 20+、wails3 CLI（`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16`）

```powershell
powershell -File scripts\build.ps1     # 前端 + exe + 体积断言
```

图标或版本信息变更后：

```powershell
go run ./cmd/genicon                   # 生成 icon.ico，并同步生成 frontend/public/icons/ 下的 PWA/安卓图标
# 发布构建会自动使用 go-winres patch 注入图标、版本和 manifest
```

诊断日志默认保存在 `%APPDATA%\\mini-vedio\\diagnostics.jsonl`，也可从应用帮助菜单导出。

## 架构一览

媒体引擎直接使用 WebView2（Chromium）内置的 WebRTC，Go 不做任何媒体处理——这是单文件、小体积、浏览器级通话质量的来源。Go 侧仅承担窗口壳、局域网发现与信令中继。设计细节、硬约束与里程碑见 [AGENTS.md](AGENTS.md)。

```
┌────────────── 单个 exe（Go + Wails v3）──────────────┐
│  WebView2 窗口                Go 内核                  │
│  ├ 前端(Vue3): 采集/RTCPeerConnection   ├ LAN 发现(internal/lan)
│  ├ DTLS-SRTP 端到端加密媒体             ├ 信令中继 + 事件推送
│  └ 邀请码/聊天/屏幕共享                  └ 设备身份 / serve 模式
└──────────────┬───────────────────────────────────────┘
               └──────── P2P 直连（信令只搬运 SDP 文本）──────── 对端
```
