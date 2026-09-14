/**
 * SDP 精简器：剔除浏览器自动生成但建连非必需的行，使邀请码/回复码
 * 短到能通过聊天工具的输入长度限制（微信等约 1–2K 字符上限）。
 *
 * 保留：会话头、BUNDLE、ICE/DTLS 传输与安全、必要编解码（opus/VP8/H264）
 * 及其重传/带宽估计反馈、候选地址、数据通道。
 * 丢弃：RTX 重传流（实测 Chromium 会拒绝精简 SDP 中的 rtx 载荷，报
 * "send parameters" 错误；NACK 重传不依赖 RTX 也可用）、RTP 扩展、
 * 冗余编解码（PCMU/red/ulpfec/...）、其余反馈类型、多流扩展。
 *
 * 编解码的载荷类型号沿用原始 SDP（rtpmap 一并保留），精简后的
 * offer/answer 仍然自洽，Chrome/WebView2 可正常应答。
 */

const KEEP_CODECS = new Set(['opus', 'VP8', 'H264'])

const KEEP_FB = ['nack', 'goog-remb', 'transport-cc', 'ccm fir']

function ptOf(line: string): string {
  const m = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(line)
  return m ? m[1] : ''
}

function codecOf(rtpmapValue: string): string {
  // "111 opus/48000/2" -> "opus"
  const parts = rtpmapValue.trim().split(/\s+/)
  return (parts[1] ?? '').split('/')[0]
}

export function minifySdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter((l) => l.trim() !== '')

  // 第一遍：PT -> 编解码名映射（Chrome 的 PT 在单条 SDP 内全局唯一）
  const ptCodec = new Map<string, string>()
  for (const line of lines) {
    if (!line.startsWith('a=rtpmap:')) continue
    ptCodec.set(ptOf(line), codecOf(line.slice(line.indexOf(':') + 1)))
  }

  // 第二遍：按规则输出
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const parts = line.split(' ')
      const pts = parts.slice(3).filter((pt) => KEEP_CODECS.has(ptCodec.get(pt) ?? ''))
      out.push(pts.length > 0 ? [...parts.slice(0, 3), ...pts].join(' ') : line)
      continue
    }
    if (line.startsWith('a=rtpmap:') || line.startsWith('a=fmtp:') || line.startsWith('a=rtcp-fb:')) {
      if (!KEEP_CODECS.has(ptCodec.get(ptOf(line)) ?? '')) continue
      if (line.startsWith('a=rtcp-fb:')) {
        const segs = line.split(':')
        const fb = segs.slice(2).join(':')
        if (!KEEP_FB.some((k) => fb === k || fb.startsWith(k + ' '))) continue
      }
      out.push(line)
      continue
    }

    const essential =
      /^(v=|o=|s=|t=|a=group:|a=msid-semantic:)/.test(line) ||
      /^(c=|a=mid:|a=ice-ufrag:|a=ice-pwd:|a=setup:|a=fingerprint:|a=rtcp-mux|a=sendrecv|a=sendonly|a=recvonly|a=inactive|a=msid:|a=ssrc-group:|a=ssrc:|a=candidate:|a=end-of-candidates|a=sctp-port:|a=max-message-size:|a=ice-options:)/.test(
        line,
      )
    if (essential) out.push(line)
    // 其余（extmap、rtcp、拥塞控制扩展声明等）一律丢弃
  }
  return out.join('\r\n') + '\r\n'
}
