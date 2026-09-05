# mini-vedio 代码 Review（21:06 快照）

> **21:22 复查更新**：§2 中的 2-1（zip bomb catch 缺陷）、2-2（Peers/emitPeers nil）、2-4（日志轮转+限频）、2-6（中文截断）已全部被修复，新增 `diagnostics_test.go` 两个针对性测试，`go test ./...` 通过。§3 的长期项（P0-2/P0-4/P0-5/P1-2/P1-7/P2-3/P2-4）仍未动。详情见文末「21:22 复查」一节。

> 基于 2026-09-05 21:06 的工作区快照。`go vet ./...` 通过。
> 此前另一 Agent 会话在 20:37–21:05 间持续修改代码，本次 review 重点看新增/改动文件。
> 与上一份 `REVIEW-2026-09-05.md`（设计审查）互补：那份列的问题，这里标注哪些已被修复。

## 1. 并行会话已修复的问题（对应原审查）

| 原编号 | 问题 | 修复位置 | 评价 |
|---|---|---|---|
| P0-3 | TURN/STUN 不可配置 | `network.ts` + `TopNavigation.vue` 设置入口 + `call.ts:118` `iceServers()` | ✅ 完整。STUN 默认值保留，TURN 可选，凭据走 localStorage。**但凭据明文存盘**（见 §2） |
| P1-3 | 邀请码 zip bomb | `invite.ts:5-6` `MAX_CODE_LENGTH`/`MAX_PAYLOAD_BYTES` | ⚠️ 有缺陷（见 §2-1） |
| P1-4 | `atob` 异常未捕获 | `invite.ts:21-25` try/catch | ✅ 完整 |
| P2-1 | `answers`/`offers` 永不清理 | `lan.go` `cachedAnswer{seen time}` + `prunePeers` 按 `cacheTTL=2min` 清理 | ✅ 完整 |
| P2-2 | `s.hub` 无 nil 保护 | `lanservice.go` 大部分方法加 `if s.hub == nil` | ⚠️ 部分（见 §2-2） |

**额外加固**（原审查未列、本次新增）：
- `lan.go` 新增 `validCall`/`validSDP` 输入校验（`maxCallIDBytes=128`、`maxSDPBytes=64KB`），在 `SendOffer`/`AcceptCall`/`DeclineCall`/`SendBye`/`handle` 全路径调用。挡住了超大包 DoS。
- `lan.go:528` `handle` 入口校验 `m.SigPort` 在 1–65535。
- 诊断日志（`diagnostics.go`/`diagnostics.ts`）隐私设计正确：只记字节数与事件名，不记 SDP/邀请码内容，`Detail` 截断到 500 字节。
- 联系人/通话记录（`contacts.ts`/`history.ts`）用 `{{ }}` 插值，无 `v-html`，无 XSS。

## 2. 新引入或仍未修的问题

### 2-1 zip bomb 检测被 catch 吞掉（新 bug，P1-3 修复有缺陷）
`invite.ts:42-52` `inflate()`：
```ts
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  try {
    const stream = ...
    const output = new Uint8Array(await new Response(stream).arrayBuffer())
    if (output.length > MAX_PAYLOAD_BYTES) throw new Error('邀请码内容过大')  // ← 在 try 内
    return output
  } catch {
    return null  // ← 上面的 throw 被这里吞掉
  }
}
```
检测到大输出的 `throw` 被 `catch` 捕获后返回 `null`，调用方 `(await inflate(bytes)) ?? bytes` 改用未解压的原始 bytes，后续 `JSON.parse` 失败报"内容不是有效邀请"——**内存没被撑爆**（因为没真正持有解压结果），但错误提示不对，且防御变成隐式的。
**修法**：把大小检查移出 try，或让 catch 区分"解压失败"与"超限"。

### 2-2 `Peers()` / `emitPeers()` 仍裸调用 `s.hub`（P2-2 未完全修）
`lanservice.go:73` `Peers()` 和 `:204` `emitPeers()` 直接 `s.hub.Peers()`，无 nil 检查。`Peers` 是暴露给前端的绑定方法，在 `ServiceStartup` 完成前调用会 nil panic。`emitPeers` 只在启动后调用，相对安全但仍建议加。

### 2-3 TURN 凭据明文存 localStorage
`network.ts:39` `localStorage.setItem('mv:network-settings', JSON.stringify(normalized))` —— `turnCredential` 明文落盘。WebView2 的 localStorage 在磁盘上是明文（devtools 已关但仍可被同用户进程读）。
**建议**：至少在设置页提示"TURN 密码以明文保存于本机"，或考虑用 Go 侧 DPAPI 加密存（但会增加体积）。

### 2-4 诊断日志无轮转、无频率限制
- `diagnostics.go` `appendDiagnostic` 每次调用 `OpenFile`+`Write`+`Close`，且文件**无限增长**。`readDiagnostics` 只读 2MB，但文件本身可能远超。建议加大小轮转（超 1MB 截断或滚动）。
- `LogDiagnostic` 暴露给前端，**无频率限制**。serve 模式下任意加载页面的浏览器可高频调用灌爆 `%APPDATA%\mini-vedio\diagnostics.jsonl`。建议加每秒上限。

### 2-5 来电互相覆盖未修（原 P1-7）
`call.ts:477` `lanIncoming.value = (ev as {data?: LanIncoming}).data ?? null` 仍直接赋值覆盖。第二个来电会静默替换第一个，被覆盖的呼叫方空等 30 秒超时。无振铃音也未补。

### 2-6 `diagnostics.go` 截断按字节，可能截断中文
`truncateDiagnostic` 用 `value[:max]`，Go 字符串是字节切片，截断到 UTF-8 多字节中间会产生无效 UTF-8。`event`/`detail` 以英文为主影响小，但调用方可能传中文错误信息。建议转 `[]rune` 再截。

### 2-7 `call.ts` 缩进混乱
`call.ts:459-468` 用 tab，`:471+` 用空格，同函数内两种缩进。不影响运行但可读性差，说明手动编辑未格式化。建议跑 `prettier` 统一。

### 2-8 `SetName` 仍用字符串拼路径
`lanservice.go:101` `dir+"\\device.json"` —— 未改用 `filepath.Join`（原 P2 已列，未修）。

## 3. 仍未修复的原审查问题

| 原编号 | 问题 | 状态 |
|---|---|---|
| P0-1 | 未 git init | 仓库已 init（20:36），但未提交（等并行会话完工） |
| P0-2 | 无 WebView2 检测 | 未实现 |
| P0-4 | SAS 静默降级 | 未修（`sas.ts`/`ConnectionStatus.vue` 未动） |
| P0-5 | LAN 信令零认证 | 未修。`validCall`/`validSDP` 只防大包，不防身份伪造（无签名/MAC） |
| P1-1 | 体积余量 | **纠正**：原报告算错，实际余量约 715 KB（非 160 KB），见下 |
| P1-2 | LAN 呼叫 4 秒延迟 | 未修（仍 `gatheringComplete` 4s） |
| P1-5 | 通话计时器 | 未实现 |
| P1-6 | signal 中继模式 | 未实现 |
| P2-3 | `readLoop` 出错即 continue | 未修 |
| P2-4 | serve 证书带 CA 权限 | 未修 |
| P2-5 | 文档与实现不一致 | AGENTS.md 在 21:05 刚被改，建议核对是否同步了上述修复 |

## 4. 体积口径纠正

原审查 P1-1 说"12.84 MB / 上限 13 MB，余量仅 160 KB"——**算错了**。我用了十进制 MB（÷1,000,000）对比 PowerShell 二进制 MB（÷1,048,576，`build.ps1` 的口径）。

- 当前 exe：12,888,064 B ÷ 1,048,576 = **12.29 MB**
- 上限 13 MB = 13,631,488 B
- 实际余量 ≈ **715 KB**（不是 160 KB）

TURN 设置页 + 诊断日志 + 联系人/记录这些新功能都塞进去了，体积仍有余量。原报告"会立刻爆断言"的判断言重了。

## 5. 优先级建议

1. **修 2-1**（zip bomb catch 缺陷）—— 一行改动，防御变显式
2. **修 2-2**（`Peers()` 加 nil 检查）—— 一行改动，防 panic
3. **修 2-4**（诊断日志轮转 + 频率限制）—— 防磁盘灌爆
4. **核对 AGENTS.md**（21:05 改过）是否同步了 TURN/诊断/联系人这些新功能，避免 §12 DoD 第 6 条"文档与实现不同步"再次违反
5. 原 P0-2（WebView2 检测）、P0-4（SAS 静默降级）、P0-5（信令认证）仍未动，建议排期

---

## 21:22 复查

并行会话在 21:14–21:21 响应了本 review，以下 4 项已修复，质量验证如下：

| 项 | 修复 | 验证 |
|---|---|---|
| 2-1 zip bomb | `inflate` 解压移入 try，大小检查移到 try 外，超限显式抛"邀请码内容过大" | ✅ 修复正确，防御已显式 |
| 2-2 hub nil | `Peers()` 返回空切片；`emitPeers()` 加 `s.hub == nil` 判断 | ✅ 完全修复，且有测试覆盖 |
| 2-4 日志 | 文件超 2MB 轮转为 `.1`（总占用 ≤4MB）；每分钟 600 次写入限频；导出上限 4MB | ✅ 并发安全（锁内完成计数与轮转） |
| 2-6 中文截断 | `truncateDiagnostic` 改用 `[]rune` | ✅ 有 `TestTruncateDiagnosticPreservesUTF8` 覆盖 |

新增测试：`diagnostics_test.go`（UTF-8 截断 + Peers-before-startup），`go test ./...` 全部通过。

新功能：通话布局互换（`VideoRoom.vue` 的 `swapped` + `largeStream`/`pipStream` computed 派生，实现干净无副作用）。exe 已于 21:21 重新构建，包含全部改动（已验证无晚于 exe 的源码）。

### 仍未修的长期项

P0-2（WebView2 检测）、P0-4（SAS 静默降级，`v-if="... && call.sasCode"` 仍直接隐藏按钮）、P0-5（信令零认证）、P1-2（LAN 呼叫 4s 延迟）、P1-7（来电覆盖，`call.ts:487` 仍直接赋值）、P2-3（readLoop 错误即 continue）、P2-4（serve 证书带 CA 权限）。

### 当前最大风险：git 仍未提交

仓库 20:36 init 后至今零提交。并行会话改动持续累积（diagnostics/contacts/history/network/布局互换/托盘……），全部工作无版本控制兜底。**建议立即提交一个快照**——不必等会话完工，git 的意义就是随时可回滚。
