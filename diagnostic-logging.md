# 诊断日志与邀请码排障

## 导出

在应用右上角打开“帮助”，点击“导出诊断日志”。桌面端日志同时保存在：

```text
%APPDATA%\mini-vedio\diagnostics.jsonl
```

每行是一条 JSON，包含时间、级别、事件和摘要。日志不会写入完整邀请码、SDP、音视频数据或 TURN 密码。
日志文件达到 2 MB 后自动轮转，并限制单进程每分钟最多写入 600 条，避免异常页面灌满磁盘。

## 重点事件

- `invite.encode` / `invite.decode.ok`：邀请码生成和解析长度、类型。
- `invite.decode.reject`：Base64、压缩、JSON 或 payload 阶段的失败原因。
- `webrtc.peer.create`、`webrtc.ice.connected`、`webrtc.ice.failed`：WebRTC 建连阶段。
- `lan.offer`、`lan.answer`、`lan.event`：局域网信令摘要。
- `media.request`、`media.video.failed`、`media.audio.failed`：采集权限和设备问题。

## 邀请码格式

当前兼容以下形式：

- `MV1-<Base64URL>`：应用当前生成格式。
- `MV1-OFFER:<Base64URL>` / `MV1-ANSWER:<Base64URL>`：文档和旧版本格式。
- 命名格式的 payload 可以是 JSON 包装，也可以是直接压缩/未压缩 SDP。
