// 从双方 SDP 中提取 DTLS 证书指纹，生成 6 位短认证串（SAS）。
// 双方各自独立计算并人工比对，一致即可确认信令链路未被中间人替换指纹
// （信令无论经局域网、邀请码还是服务器传输，该防护都成立）。
export async function computeSas(localSdp: string, remoteSdp: string): Promise<string> {
  const fingerprint = (sdp: string): string => {
    const m = /a=fingerprint:(?:sha-256|sha-384|sha-512)\s+([0-9A-Fa-f:]+)/.exec(sdp)
    return m ? m[1].replace(/:/g, '').toLowerCase() : ''
  }
  const a = fingerprint(localSdp)
  const b = fingerprint(remoteSdp)
  if (!a || !b) return ''
  const [x, y] = a <= b ? [a, b] : [b, a]
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x + y))
  const hex = Array.from(new Uint8Array(digest).slice(0, 3), (v) =>
    v.toString(16).padStart(2, '0'),
  )
  return hex.join('').toUpperCase().replace(/(..)/g, '$1-').replace(/-$/, '')
}
