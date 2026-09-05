# 安卓打包（PWA + TWA）指南

> 前端已完成 PWA 化：`public/manifest.webmanifest` + `public/sw.js` + `public/icons/*`。
> Service Worker 仅在 HTTPS（或 localhost）安全上下文注册，桌面 exe 行为不受影响。

## 原理与取舍

- APK 采用 **Trusted Web Activity（TWA）**：安卓系统 Chrome 内核全屏承载本前端，
  媒体栈即浏览器 WebRTC（DTLS-SRTP 端到端加密），与桌面端同源同质量。
- **信令走邀请码（纯前端计算）**，APK 安装后不需要任何后端；STUN/TURN 需要外网。
- **取舍**：TWA 没有本地 UDP 权限，「局域网自动发现」在安卓端不可用，跨网通话全部走
  邀请码模式；TWA 校验要求前端托管在一个 HTTPS 域名上（静态托管即可，页面本身不含后端）。

## 步骤

### 1. 构建前端

```powershell
npm --prefix frontend run build   # 产物在 frontend/dist/
```

### 2. 托管 dist（任选其一，均为免费静态托管）

- GitHub Pages：把 `frontend/dist` 推到 `user.github.io/mini-vedio` 之类仓库
- Cloudflare Pages：直接拖拽 `dist` 目录上传
- 自有服务器/NAS：任意 HTTPS 静态服务

部署后用手机浏览器打开 `https://<域名>/`，验证：能安装（Chrome 菜单「添加到主屏幕」）、
邀请码通话可打通。**这一步不打包 APK 也已经能让手机像 App 一样使用**（PWA 独立窗口运行）。

### 3a. 生成 APK —— PWABuilder（推荐，本机零工具链）

1. 打开 <https://www.pwabuilder.com>，输入托管地址
2. Packaging → Android → Download，得到已签名的 `app-release-signed.apk`
   与 `assetlinks.json`
3. 把 `assetlinks.json` 放到托管的 `https://<域名>/.well-known/assetlinks.json`
   （不做这一步安装后地址栏不会隐藏，功能不受影响）
4. **妥善保存 PWABuilder 生成的签名 key（`signing.keystore` / store 口令）**，
   丢失后无法对同一应用发升级版

### 3b. 生成 APK —— bubblewrap CLI（本地构建，需 JDK 17 + Android SDK 约 3–4 GB）

> ⚠️ 本机磁盘紧张（见 AGENTS.md C4），除非磁盘放宽否则不建议本地构建。

```powershell
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://<域名>/manifest.webmanifest
bubblewrap build   # 产出 app-release-signed.apk + assetlinks.txt
```

`bubblewrap init` 会生成 `twa-manifest.json`，可参考本目录
`twa-manifest.example.json` 中的推荐取值（包名、display 模式、主题色等）。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 手机上 SW 未注册 / 无法安装 | 必须是有效证书的 HTTPS；serve 模式自签证书下属预期，仅提示不可安装 |
| 通话连不上 | 双方均在对称 NAT 后且未配 TURN → 在设置页填写 TURN；否则检查 STUN 可达 |
| 局域网列表为空 | TWA 无 UDP 权限，属预期；使用邀请码模式 |
| 更新不生效 | SW 导航请求为网络优先，强制刷新一次或等缓存回填；发新版可把 `sw.js` 中 `CACHE` 版本号 +1 |
