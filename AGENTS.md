# AGENTS.md — mini-vedio（WebRTC 双人音视频通话）

> 本文件是本仓库的"项目宪法"。任何 Agent 或贡献者在本仓库工作前必须完整阅读；
> 改动架构、依赖或体积策略前，必须先更新本文件再动代码。

## 1. 一句话目标

一个**单文件 exe、双击即用**的 Windows 端 WebRTC 实时音视频通话应用：
同局域网自动发现对端一键直连；跨网络用"邀请码"直连；媒体全程加密；体积与磁盘占用压到极限。

## 2. 硬约束（优先级最高，违反即返工）

| # | 约束 | 指标 | 说明 |
|---|------|------|------|
| C1 | 交付形态 | 单个 .exe，无安装过程 | 依赖系统预装的 WebView2 运行时 |
| C2 | exe 体积 | ≤ 13 MB（目标 10–11 MB） | 2026-09-05 由 12 MB 上调：serve 模式引入 net/http + crypto/x509（+0.86 MB）；构建脚本含体积断言 |
| C3 | 启动时间 | 双击 → 主界面 ≤ 1 s | |
| C4 | 开发期新增磁盘占用 | ≤ 1 GB | 本机磁盘紧张（见 §3），这是选型的第一约束 |
| C5 | 运行内存 | ≤ 250 MB | 以 WebView2 进程为主，属正常水位 |
| C6 | 安全基线 | 媒体强制加密 + 信令防中间人 | 见 §6 |
| C7 | 可诊断性 | 新增关键功能必须可导出诊断日志 | 关键入口、外部接口、状态转换、失败/重试、完成/清理都要记录摘要；日志不得包含完整 SDP、邀请码正文、媒体内容、密码或令牌 |

### Agent 磁盘纪律
- **node_modules 仅允许存在于 frontend/ 目录**，依赖保持最小集（Vue 3 / Vite / TypeScript / Tailwind CSS / lucide-vue-next，2026-09-05 按用户要求引入）；禁止再新增其他 UI 框架或工具链。
- **禁止 CGO**。保持纯 Go（利于体积、交叉编译，也减少攻击面）。
- **禁止引入新运行时/框架**（Electron、Tauri、.NET、Flutter、Python 打包等，理由见 §4.2）。
- 新增第三方 Go 依赖前：评估其间接依赖数量与磁盘/体积影响并写入汇报；能用标准库就不引库。
- C 盘余量 < 1 GB 时先执行 `go clean -cache`；**不要**把缓存指到 D 盘（仅 0.8 GB 余量）。

## 3. 本机环境事实（2026-09-05 实测，选型依据）

| 项 | 状态 |
|---|---|
| 磁盘余量 | C: 12.5 GB ｜ E: 3.5 GB ｜ D: 0.8 GB |
| Go | ✅ go1.26.1（C:\Program Files\Go） |
| WebView2 运行时 | ✅ 152.0.4191.62（已预装，勿重复安装） |
| Wails CLI | ✅ wails3 v3.0.0-beta.16（`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16`，锁定不追新） |
| go-winres | ✅（`go install github.com/tc-hib/go-winres@latest`，构建后注入图标/版本/清单；Go 1.26 链接器不嵌 syso，勿走 syso 路线） |
| node/npm、rust/cargo、dotnet、git | 本机已存在，但本项目**一律不用**（git 可选用于版本管理） |
| Visual Studio | 已安装，但纯 Go 方案用不到 MSVC |
| 工作区 E:\mini-vedio | 空目录，尚未 git init |

## 4. 技术选型（已定，勿反复论证）

### 4.1 选型结论

| 层 | 选择 | 关键理由 |
|---|---|---|
| 语言/工具链 | **Go 1.26**（本机已装，增量磁盘 ≈ 0） | 静态编译出单文件 exe；编译快；工具链最省盘 |
| 桌面壳 | **Wails v3（Beta，锁定具体版本）** | Windows 下纯 Go 无 CGO；前端资源内嵌；提供 `Permissions` API 显式管理摄像头/麦克风权限；官方称桌面 API 已稳定 |
| 媒体引擎 | **WebView2（Chromium）内置 WebRTC 栈** | 核心决策，见下框 |
| 前端 | Vue 3 + TypeScript + Vite + Tailwind CSS v4 + lucide-vue-next（用户指定） | 组件化与类型安全；构建产物 `frontend/dist/` 由 Wails 内嵌；已 PWA 化（manifest + SW + 图标，见 §4.4），浏览器端可安装为应用并支持 TWA 打包 APK |
| NAT 穿透 | 公共 STUN（默认，可配置）+ 可选 TURN（设置页填写） | 覆盖大多数场景；TURN 兜底对称 NAT |
| 局域网发现 | UDP 广播（JSON 心跳报文） | 无服务器、双击即见对方 |
| 信令 | ① LAN UDP 单播 ② 邀请码（带外人工传递） ③ 可选 `signal` 服务器模式（同一个 exe） | 三种模式共用一套 `SignalMessage` JSON 格式 |
| WebSocket 库（仅模式③用） | `github.com/coder/websocket` | 唯一的非标准库网络依赖，体积影响 < 1 MB |
| 压缩（邀请码用） | `compress/flate` | 标准库，零依赖 |

> **核心架构决策——媒体引擎不在 Go 里实现。**
> 摄像头/麦克风采集、编解码（H.264/VP8/Opus）、回声消除（AEC3）、降噪、DTLS-SRTP 加密、
> ICE 传输，全部直接使用 WebView2（Chromium）内置的 WebRTC；**Go 只做窗口壳、信令转发、
> 局域网发现、SAS 核对码、设置存储**。
> 收益：不引入 Pion/FFmpeg/任何编解码库 → exe 最小、代码最少；白拿 Chromium 的回声消除与硬件编解码；
> 媒体加密由 WebRTC 规范强制保证。
> 代价（已接受）：依赖 WebView2 运行时（Win10/11 基本预装，启动时检测并提示官方安装器）；
> 未来移植 Linux/macOS 需重新评估 WebKit 的采集权限问题（见 §9 Backlog）。

### 4.4 PWA / 移动端（2026-09-05 新增）

- 前端 PWA 化：`frontend/public/`（manifest.webmanifest、sw.js、icons/）。SW 仅在浏览器安全上下文
  （HTTPS 或 localhost）且非桌面壳内注册（`main.ts` 守卫 + `pwa.sw.*` 诊断事件），桌面 exe 路径零影响。
- vite `base: './'` 相对路径，便于托管到任意子路径（GitHub Pages 等）。
- 安卓打包走 PWA + TWA（Trusted Web Activity）：APK 构建推荐线上 PWABuilder（本机零工具链）；
  本地 bubblewrap 需 JDK+SDK 3–4 GB，受 C4 约束默认不做。步骤见 docs/android-packaging.md。
- **移动端能力边界**：浏览器/TWA 无 UDP 权限 → 无局域网自动发现；信令仅邀请码模式；
  Wails v3 不支持 Android，安卓系统 WebView 不能替代（getUserMedia 受限）——不要提议原生壳方案。

### 4.2 被否决的方案（勿再提）

| 方案 | 否决原因 |
|---|---|
| Electron | exe 150–200 MB；node_modules 动辄数 GB，直接爆磁盘预算 |
| Tauri (Rust) | 产物虽小，但需 Rust + MSVC 工具链 2–4 GB，超磁盘预算 |
| .NET + NativeAOT | SDK ~1 GB，且 NativeAOT 必须 MSVC 链接器 |
| C++ (libdatachannel) | 工具链 6 GB+，开发效率低 |
| Flutter | SDK 3 GB+，产物 20 MB+ |
| Python (aiortc/PyInstaller) | 产物 100 MB+，启动慢，无系统级回声消除 |
| Go + Pion 自管媒体 | Pion 只管传输不管采集/编码；采集与编码需 CGO/FFmpeg → 体积与磁盘双爆，且丢失 AEC |

> 若未来磁盘放宽（> 10 GB），Tauri v2 可重新评估；在此之前不讨论。

### 4.3 回退方案

Wails v3（Beta）若出现阻塞性 bug：回退 **Wails v2**（长期稳定版）。已核实 v2 在 Windows 上
`getUserMedia` 同样原生可用（WebView2 行为，参考 wailsapp/wails#5540、discussion #3579），
仅权限处理不如 v3 的 `Permissions` API 显式。

## 5. 架构

```
┌─────────────────────────── 单个 exe（Go） ───────────────────────────┐
│   Wails v3 窗口 + WebView2                                           │
│   ┌────────────────────────────┐        ┌─────────────────────────┐  │
│   │ 前端（内嵌 HTML/JS，无构建） │        │ Go 内核                  │  │
│   │  getUserMedia 采集/预览     │◄──────►│  LAN UDP 广播发现         │  │
│   │  RTCPeerConnection         │ 绑定调用│  邀请码生成/解析           │  │
│   │  通话 UI（静音/挂断/计时）   │        │  SAS 核对码计算            │  │
│   └─────────────┬──────────────┘        │  设置存储 / signal 服务器  │  │
│                 │                       └───────────┬─────────────┘  │
│                 │ 媒体：DTLS-SRTP 端到端              │ 信令消息         │
└─────────────────┼───────────────────────────────────┼────────────────┘
                  ▼                                   ▼
            对端 WebView2  ◄────── P2P 媒体直连 ──────►  对端（信令通道）
```

- 媒体：前端 `RTCPeerConnection` 与对端直连，Go 不碰任何媒体数据。
- 信令：只搬运 SDP/ICE 文本；信令通道即使被窃听也不破坏媒体机密性（身份防伪靠 §6 SAS）。

### 5.1 三种连接模式（同一套 `SignalMessage` JSON）

| 模式 | 场景 | 机制 |
|---|---|---|
| 局域网 | 同网段，零配置 | UDP 逐网卡定向广播 `:47824`（多网卡/VPN 下不再走错出口）互相发现 → 单播交换 offer/answer → 用主机候选直连，无需 STUN；跨网段/AP 隔离时可用「IP 直连」单播兜底 |
| 邀请码 | 跨网络 | 非 trickle ICE：等候选收集完成 → 整包 SDP flate 压缩 + base64url → `MV1-OFFER:…` / `MV1-ANSWER:…` 二段式互换 → 经公共 STUN 直连 |
| 信号服务器（可选） | 双方可上网且有人自建中转 | 同一 exe 加 `signal` 子命令即变成转发服务器（wss，无持久化、无账号）；客户端在设置页填 wss 地址 |

- 默认 STUN：`stun.l.google.com:19302`、`stun.cloudflare.com:3478`（设置页可改）。
- 连接失败必须给可读的分类提示：ICE failed → 提示"可能被 AP 隔离或对称 NAT，改用邀请码或配置 TURN"。

## 6. 安全设计（验收必查项）

| 措施 | 说明 |
|---|---|
| 媒体加密 | WebRTC 规范强制 DTLS-SRTP，不可关闭 |
| **SAS 核对码（防信令中间人）** | 双方各算 `sha256(字典序拼接的双方 DTLS 证书指纹)` 取前 3 字节 → 6 个十六进制字符显示为 `ABC-123`；通话中常显，双方人工比对一致后点"已核实"变绿。对三种信令模式通用；指纹从本端证书与对端 SDP `a=fingerprint` 提取 |
| 权限最小化 | Wails `Permissions` 显式配置：`Camera`、`Microphone` = Allow（请求只可能来自应用自身内嵌页面）；未列出的能力走 WebView2 原生提示。采集权限仅在进入通话界面时申请 |
| 页面来源唯一 | 前端资源 `go:embed` 内嵌，仅加载自有来源；CSP：`default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`；不加载任何远程内容 |
| 发布版加固 | release 构建禁用 devtools 与右键菜单；代码零遥测、零统计 |
| 邀请码使用守则 | README 告知用户：邀请码只私聊发给通话对象；泄露邀请码不等于被窃听（有 SAS 兜底），但可能被陌生人呼叫 |
| 隐私 | 通话记录与联系人仅存前端本地存储；诊断日志存 `%APPDATA%\mini-vedio\diagnostics.jsonl`（2 MB 轮转并限频）；TURN 凭据仅保留当前会话 |

### 6.1 诊断日志要求（所有新增功能必须遵守）

- 每个新增关键功能必须接入统一诊断日志管线，并能通过应用内“帮助 → 导出诊断日志”导出；不得只写控制台日志。
- 至少记录：功能开始、关键外部接口调用、状态转换、失败/重试、成功完成和资源清理；网络功能还要记录连接模式、目标类型、耗时、载荷长度和错误分类。
- 日志使用结构化 JSONL，事件名稳定、字段简短、可检索；错误必须保留上下文并使用可读分类，禁止吞掉关键错误。
- 日志只记录摘要和元数据，不记录完整 SDP、邀请码正文、音视频数据、密码、TURN credential、访问令牌或用户输入原文。
- 诊断文件必须有大小轮转和写入限频；截断日志字段必须按 Unicode 字符处理，不能直接按 UTF-8 字节切片。
- 新增功能必须补充对应的排障说明和至少一个日志路径测试；若功能无法导出日志，视为未完成。

注意：若 Windows"设置 → 隐私 → 相机/麦克风"对桌面应用关闭，采集会失败——
必须捕获 `NotAllowedError` / `NotReadableError` 并给出中文指引（测试矩阵 M-7）。

## 7. 目录结构（规划）

```
mini-vedio/
├── AGENTS.md            # 本文件
├── README.md            # 用户文档
├── main.go              # Wails 入口：窗口、Camera/Mic 权限静默放行、服务注册、serve 子命令分发
├── diagnostics.go       # 结构化诊断日志持久化、读取与清理
├── device.go            # 设备标识持久化（%APPDATA%\mini-vedio\device.json）
├── lanservice.go        # 绑定服务：Peers/SendOffer/AcceptCall/… + 事件转发前端
├── serve.go             # serve 子命令：自签 HTTPS 网页入口（手机浏览器跨网测试用）
├── internal/lan/        # UDP 广播发现 + 信令中继（纯标准库，含双 Hub 集成测试）
├── bindings/            # wails3 generate bindings 产物（前端 import，勿手改）
├── cmd/genicon/         # 构建期图标生成器（由 icon.svg 光栅化出 ICO/PNG，零依赖）
├── winres/              # go-winres 配置（图标 PNG/版本信息/manifest）
├── scripts/build.ps1    # 发布构建：前端 → exe → go-winres patch → 体积断言
├── docs/                # android-packaging.md（PWA+TWA 安卓打包指南）等文档
├── build/windows/       # icon.svg（设计源）/ icon.ico / icon.png
├── frontend/            # Vue 3 + Vite 前端（node_modules 仅限此目录）
│   ├── src/components/  # 通话、记录、联系人、PeerList、IncomingCall 与移动端导航
│   ├── src/services/    # call.ts（状态机）/ invite.ts / diagnostics.ts / history.ts / contacts.ts
│   ├── public/          # PWA 资源（manifest.webmanifest / sw.js / icons/），genicon 同步生成图标
│   └── dist/            # 构建产物，go:embed 内嵌
└── bin/                 # 构建输出 mini-vedio.exe
```

## 8. 构建、体积与性能

### 8.1 构建命令（M0 后按 wails3 实际命令回填修正）

```powershell
# 一键发布构建（前端 → exe → 资源注入 → 体积断言）
powershell -File scripts\build.ps1

# 仅改前端后快速构建
npm --prefix frontend run build
go build -trimpath -ldflags "-s -w -H=windowsgui" -o bin/mini-vedio.exe .
& "$env:USERPROFILE\go\bin\go-winres.exe" patch --no-backup bin/mini-vedio.exe   # 须在仓库根目录执行

# Go 服务有变更后重新生成绑定
wails3 generate bindings -clean -d bindings

# 图标设计源为 build/windows/icon.svg；变更后: go run ./cmd/genicon
# 注意: Go 1.26 链接器不嵌入 syso 资源，图标/版本必须走 go-winres patch，勿走 syso 路线
```

### 8.2 体积优化清单（每次发布前逐项确认）

- [ ] 纯 Go、零 CGO（`go env CGO_ENABLED` 为 0）
- [ ] `-ldflags "-s -w" -trimpath` 生效
- [ ] 前端资源已 `go:embed`，无外部文件依赖
- [ ] 未引入 UPX（默认禁用：未签名 exe 加壳会大幅提高杀软误报率；仅实验对比时手动用）
- [ ] 体积断言通过：构建产物 ≤ 12 MB
- [ ] §8.3 体积记录表已更新

### 8.3 体积记录（M0 起维护，防回归）

| 里程碑 | exe 大小 | 备注 |
|---|---|---|
| M0–M4（Wails beta.16 + 完整前端 + LAN 服务 + 诊断日志） | 12.29 MB | `-ldflags "-s -w" -trimpath`，达标 ≤13 MB |
| PWA 化（manifest/SW/icons 内嵌，2026-09-05） | 12.31 MB | 增量约 57 KB（图标+SW+manifest），达标 |

## 9. 里程碑（严格按序，M0 优先消灭最大技术风险）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 环境与风险验证** | 安装 wails3 并锁定版本回填 §3；vanilla 模板起骨架；骨架里加 getUserMedia 测试按钮 | exe 可运行、本机摄像头预览成功；记录体积基线 |
| **M1 最小通话** | 同一台机器开两个 exe 实例，用调试面板手工粘贴 SDP 打通 RTCPeerConnection | 双向视频+语音互通，可挂断 |
| **M2 局域网直连** | UDP 发现 + 一键呼叫 + 通话 UI（静音/开关摄像头/挂断/时长）+ SAS 码常显 | 同网段两台设备 3 秒内互见并可通话 |
| **M3 邀请码与跨网** | 邀请码二段式交换 + 公共 STUN + 设置页 + SAS"已核实"交互 | 家庭宽带 ↔ 手机热点 成功通话 |
| **M4 硬化发布** | CSP、禁 devtools、错误分支全中文、体积冲刺、图标版本信息、README | §8.2 清单全过 + §10 测试矩阵全过 |

Backlog（M4 之后，勿提前实现）：DataChannel 文件传输、多方 mesh、Linux/macOS 移植（先调研 WebKit 权限）、代码签名。

> 进度（2026-09-05）：**M0–M4 主流程完成，网络设置/中继与跨设备真机验证仍待完成。**
> - M0：exe 可运行、WebView2 内摄像头/麦克风实测可用、体积 12.25 MB（≤13 MB 达标）。
> - M1/M3：邀请码直连已在双页签实测连通；serve 网页模式（手机跨网入口）已实现并验证 HTTPS 服务。
> - M2：局域网发现/信令实现完成（集成测试通过、双实例同端口验证）；**跨两台设备真机实测待用户执行**。
> - M4：项目图标（icon.svg → ICO/PNG，经 go-winres patch 注入，标题栏/任务栏可见）、版本信息 0.1.0、
>   per-monitor v2 manifest、CSP、发布版禁 devtools/右键菜单、断线处理（M-8）、采集失败中文指引（M-7）、
>   scripts/build.ps1 体积断言、README 均已落地。
> - 2026-09-05 晚修复：① **发现结果未推送前端的缺陷**（announce 新设备时缺 lan:peers 事件——此前
>   双机列表恒空的主因）；② 广播改为逐网卡子网定向（多网卡/VPN 不再走错出口）；③ 收到心跳即单播
>   回应（双向发现不依赖广播回环）；④ 新增「IP 直连」兜底与防火墙/AP 隔离排查指引；⑤ 邀请码面板
>   二维码化 + 步骤化（码本体即建连参数，已到压缩极限，不再缩短）。
> - 2026-09-05 后续：修复邀请码命名前缀兼容、增加结构化诊断日志导出、补齐本地通话记录与联系人工具；连接失败路径统一清理状态。
> - 2026-09-05 补充：剪贴板辅助——桌面端切回窗口自动检测剪贴板中的邀请码并提示一键加入；各端输入框
>   配「从剪贴板填充」按钮（WebView2 已授权 ClipboardRead）；等待面板原始文本折叠为「查看原始文本」。
> - 2026-09-05 交互补全：① 通话布局互换（悬停小窗出现切换按钮，本地/远端大小画面互换，本地大画面自动
>   镜像，大画面双击进入系统全屏）；② 右侧聊天/参与者面板左缘可拖拽调宽（280–560px，双击复位，
>   宽度记忆）；③ 首页顶栏左侧边栏折叠按钮（状态记忆于 localStorage）。
> - 2026-09-05 黑屏修复：摄像头关闭时视频位显示占位头像（此前显示被禁用轨道的黑帧，放大后即满屏黑）；
>   小窗在等待/任何状态下保持可渲染（修复互换后小窗消失无法切回的陷阱）；视频元素 srcObject 变更后
>   追加 play() 兜底。
> - 2026-09-05 晚 PWA 化：前端新增 manifest/SW/图标（frontend/public/，genicon 同步输出），
>   SW 仅浏览器安全上下文注册（桌面路径零影响）；vite base 改相对路径；exe 12.29→12.31 MB。
>   移动端路线定为 PWA + TWA（§4.4），安卓打包文档见 docs/android-packaging.md；APK 实际构建
>   待前端托管到 HTTPS 后由 PWABuilder 完成。
> - 剩余：跨设备真机实测（局域网 + 跨网）、signal 中继模式（对称 NAT 兜底）、代码签名（可选）。

## 10. 测试矩阵（M4 验收）

| # | 场景 | 预期 |
|---|---|---|
| M-1 | 同机两实例 | 互通 |
| M-2 | 同路由两台设备（LAN 模式） | 自动发现、可通话 |
| M-3 | 手机热点下两台设备 | 同上 |
| M-4 | 跨网络（邀请码 + STUN） | 互通 |
| M-5 | 对称 NAT（企业网） | 未配 TURN 时给出明确失败原因 |
| M-6 | 无摄像头设备 | 纯语音通话可用 |
| M-7 | 系统隐私设置禁用相机/麦克风 | 中文错误指引 |
| M-8 | 对端中途退出 | 3 秒内 UI 显示"已断开" |
| M-9 | 首次运行 | README 已说明防火墙放行；无崩溃 |

## 11. 编码与提交规范

- `go vet ./...` 必须零告警；错误用 `%w` 包装并携带上下文；`context.Context` 贯穿网络调用。
- 标识符/代码用英文，注释用中文，注释写"为什么"而不是"做了什么"。
- 前端只使用 Web 标准 API，不引入运行时库；UI 文案为简体中文。
- 新增关键功能必须按 §6.1 接入诊断日志，并在应用内提供可导出的排障信息；不得以 `console.log` 代替。
- 最小改动原则：不顺手重构无关代码，保留既有注释。
- 每个 commit 聚焦一件事；提交信息中文、动词开头。
- 首次提交前先 `git init`（可选但建议）。

## 12. Agent 工作守则（Definition of Done）

每次改动完成前逐项自检：

1. 改动不违反 §2 硬约束与 §4 选型。
2. `go vet ./...` 通过；构建成功。
3. 体积未超 §8.2 断言；若增量 > 5%，在汇报中解释来源。
4. 新增依赖已说明用途、间接依赖数与体积影响。
5. C 盘余量 < 1 GB 时先 `go clean -cache` 再构建。
6. 行为/架构/命令有变化时同步更新本文件（文档与实现不同步 = 任务未完成）。
7. 新增关键功能已覆盖开始、接口、状态、失败/重试、完成/清理日志，并能从应用导出；日志未泄露敏感内容。
8. 汇报中明确：做了什么、跳过了什么验证及原因、做了哪些假设。

## 13. 风险登记簿

| 风险 | 缓解 |
|---|---|
| Wails v3 为 Beta，API 可能变动 | 锁定版本号不追新；阻塞时回退 v2（§4.3） |
| 目标机器缺 WebView2 运行时 | 启动时检测，提示微软官方 Evergreen 离线安装器 |
| Chromium 对未授权页面用 mDNS 候选隐藏本机 IP，可能影响 LAN 直连 | 通话界面先开预览（采集已授权）再建连；仍不通则回退邀请码模式 |
| Windows 隐私开关导致采集失败 | M-7 错误分支 + README 指引 |
| 路由器 AP 隔离导致 LAN 发现失败 | 报错引导改用邀请码模式 |
| 对称 NAT 无法 P2P | 设置页可配 TURN；未配置时明确报错 |
| 杀软/SmartScreen 误报（未签名单文件 exe） | 默认不用 UPX；README 说明"仍要运行"；后续可选代码签名 |
| 首次运行 Windows 防火墙弹窗 | README 说明放行专用网络 |
