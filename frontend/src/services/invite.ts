import type { InviteKind } from '../types'
import { logDiagnostic } from './diagnostics'

const PREFIX = 'MV1-'
const MAX_CODE_LENGTH = 256 * 1024
const MAX_PAYLOAD_BYTES = 512 * 1024

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new Error('邀请码格式不正确：Base64 内容损坏')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 优先经 CompressionStream 压缩（Chromium/WebView2 支持），失败则原样返回 */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
    reader = stream.getReader()
  } catch {
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PAYLOAD_BYTES) {
        await reader.cancel()
        throw new Error('邀请码内容过大')
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof Error && e.message === '邀请码内容过大') throw e
    return null
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/** 把 offer/answer SDP 编码为可复制的邀请码 */
export async function encodeInvite(kind: InviteKind, sdp: string): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ t: kind, s: sdp }))
  const packed = (await deflate(raw)) ?? raw
  const code = PREFIX + bytesToBase64url(packed)
  logDiagnostic('invite.encode', `kind=${kind} sdpBytes=${raw.length} codeBytes=${code.length}`)
  return code
}

/** 解析邀请码，自动兼容压缩与未压缩两种格式 */
export async function decodeInvite(code: string): Promise<{ kind: InviteKind; sdp: string }> {
  const cleaned = code.trim().replace(/\s+/g, '')
  if (cleaned.length > MAX_CODE_LENGTH) {
    logDiagnostic('invite.decode.reject', `reason=too_long bytes=${cleaned.length}`, 'warn')
    throw new Error('邀请码过长，请重新复制完整邀请码')
  }
  let body = cleaned
  let declaredKind: InviteKind | undefined
  const namedPrefix = /^(?:MV1-)?(OFFER|ANSWER):/i.exec(cleaned)
  if (namedPrefix) {
    declaredKind = namedPrefix[1].toLowerCase() === 'offer' ? 'o' : 'a'
    body = cleaned.slice(namedPrefix[0].length)
  } else if (cleaned.startsWith(PREFIX)) {
    body = cleaned.slice(PREFIX.length)
  }
  if (!body) throw new Error('邀请码不能为空')
  let bytes: Uint8Array
  try {
    bytes = base64urlToBytes(body)
  } catch (e) {
    logDiagnostic('invite.decode.reject', 'reason=base64', 'warn')
    throw e
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    logDiagnostic('invite.decode.reject', `reason=too_large bytes=${bytes.length}`, 'warn')
    throw new Error('邀请码内容过大')
  }
  let unpacked: Uint8Array
  try {
    unpacked = (await inflate(bytes)) ?? bytes
  } catch (e) {
    if (e instanceof Error && e.message === '邀请码内容过大') {
      logDiagnostic('invite.decode.reject', 'reason=inflated_too_large', 'warn')
      throw e
    }
    logDiagnostic('invite.decode.reject', 'reason=inflate', 'warn')
    throw new Error('邀请码格式不正确：压缩内容无法解码')
  }
  let parsed: { t?: string; s?: string } | null = null
  let rawSdp = ''
  try {
    parsed = JSON.parse(new TextDecoder().decode(unpacked))
  } catch {
    // 兼容文档中的命名格式：payload 可能直接是压缩后的 SDP。
    if (declaredKind) rawSdp = new TextDecoder().decode(unpacked).trim()
    if (!rawSdp.startsWith('v=')) {
      logDiagnostic('invite.decode.reject', 'reason=json', 'warn')
      throw new Error('邀请码格式不正确：内容不是有效邀请')
    }
  }
  const kind = declaredKind ?? parsed?.t
  const sdp = rawSdp || parsed?.s || ''
  if (!sdp || !sdp.startsWith('v=') || (kind !== 'o' && kind !== 'a') || (declaredKind && parsed?.t && parsed.t !== kind)) {
    logDiagnostic('invite.decode.reject', `reason=payload bytes=${unpacked.length}`, 'warn')
    throw new Error('邀请码格式不正确：缺少有效的 offer/answer')
  }
  logDiagnostic('invite.decode.ok', `kind=${kind} sdpBytes=${sdp.length}`)
  return { kind, sdp }
}
