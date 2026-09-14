import { computed, reactive, ref } from 'vue'
import type { CallPhase, ChatMessage, Participant } from '../types'
import { decodeInvite, encodeInvite } from './invite'
import { loadLan, loadRuntime, waitDesktop } from './lanapi'
import { computeSas } from './sas'
import { logDiagnostic } from './diagnostics'
import { addCallRecord } from './history'
import { iceServers, loadNetworkSettings, saveNetworkSettings, type NetworkSettings } from './network'
import { SignalConnection, waitSignalMessage, type SignalingChannel } from './signal'
import { PublicRelay } from './relay'

export interface LanPeer {
  id: string
  name: string
  state: string
}

export interface LanIncoming {
  from: string
  name: string
  callId: string
  sdp: string
}

// ---- 模块级单例状态：整个应用共享同一通电话 ----
const phase = ref<CallPhase>('idle')
const statusMessage = ref('')
const statusTone = ref<'info' | 'error' | 'success'>('info')
const role = ref<'caller' | 'callee' | null>(null)
const localStream = ref<MediaStream | null>(null)
const remoteStream = ref<MediaStream | null>(null)
const shareStream = ref<MediaStream | null>(null)
const micOn = ref(true)
const camOn = ref(true)
const sharing = ref(false)
const inviteCode = ref('')
const replyCode = ref('')
const panel = ref<'none' | 'participants' | 'chat'>('none')
const peerName = ref('对方')
const selfName = ref(localStorage.getItem('mv:name') ?? '本机')
const selfIPs = ref<string[]>([])
const chatMessages = ref<ChatMessage[]>([])
const detectedInvite = ref('')
const lanPeers = ref<LanPeer[]>([])
const lanIncoming = ref<LanIncoming | null>(null)
const lanReady = ref(false)
const lanStatus = ref('pending')
const lanPeerId = ref('')
const lanCallId = ref('')
const sasCode = ref('')
const sasVerified = ref(false)
const networkSettings = ref(loadNetworkSettings())
const roomCode = ref('')
const signalRoom = ref('')

let pc: RTCPeerConnection | null = null
let channel: RTCDataChannel | null = null
let savedVideoSender: RTCRtpSender | null = null
let chatId = 0
let statusTimer: number | undefined
let disconnectTimer: number | undefined
let connectionTimer: number | undefined
let joinHintTimer: number | undefined
let iceStallTimer: number | undefined
const MANUAL_HANDSHAKE_TIMEOUT_MS = 30 * 60 * 1000
const WEBRTC_CONNECT_TIMEOUT_MS = 120 * 1000
let callStartedAt = 0
let callMode: 'invite' | 'lan' | 'signal' | null = null
let signal: SignalingChannel | null = null
let signalOff: (() => void) | null = null

// ---- 远端 ICE 候选缓冲（P1 修复）----
// 信令通道本身无消息缓冲：对端 trickle 的候选可能先于 answer/offer 应用到达，
// 直接 addIceCandidate 会抛 InvalidStateError 导致候选永久丢失（ICE 候选不重传）。
// 远端描述就绪前先入队，就绪后按序回放。
let pendingIce: RTCIceCandidateInit[] = []
let remoteReady = false

function resetIceBuffer(): void {
  pendingIce = []
  remoteReady = false
}

async function applyRemoteIce(ice: RTCIceCandidateInit): Promise<void> {
  if (!pc) return
  if (!remoteReady) {
    pendingIce.push(ice)
    logDiagnostic('webrtc.ice.buffered', `queued=${pendingIce.length}`)
    return
  }
  try {
    await pc.addIceCandidate(ice)
  } catch (e) {
    logDiagnostic('webrtc.ice.apply.error', e instanceof Error ? e.message : String(e), 'warn')
  }
}

async function markRemoteReady(): Promise<void> {
  remoteReady = true
  const queued = pendingIce
  pendingIce = []
  for (const ice of queued) await applyRemoteIce(ice)
  if (queued.length) logDiagnostic('webrtc.ice.replay', `count=${queued.length}`)
}

const participants = computed<Participant[]>(() => {
  const list: Participant[] = [{ id: 'self', name: selfName.value, connected: true }]
  if (role.value !== null) {
    list.push({ id: 'peer', name: peerName.value, connected: phase.value === 'connected' })
  }
  return list
})

const inCall = computed(() => role.value !== null)

function setStatus(text: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  statusMessage.value = text
  statusTone.value = tone
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => (statusMessage.value = ''), 7000)
}

function beginCall(mode: 'invite' | 'lan' | 'signal'): void {
  callStartedAt = Date.now()
  callMode = mode
  resetIceBuffer()
  logDiagnostic('call.begin', `mode=${mode}`)
}

function recordCall(status: 'completed' | 'failed' | 'cancelled', reason = ''): void {
  if (!callStartedAt || !callMode) return
  const endedAt = new Date()
  addCallRecord({
    peerName: peerName.value,
    mode: callMode,
    status,
    startedAt: new Date(callStartedAt).toISOString(),
    endedAt: endedAt.toISOString(),
    durationSec: Math.max(0, Math.round((endedAt.getTime() - callStartedAt) / 1000)),
    reason: reason || undefined,
  })
  logDiagnostic('call.end', `mode=${callMode} status=${status} durationSec=${Math.round((endedAt.getTime() - callStartedAt) / 1000)}`)
  callStartedAt = 0
  callMode = null
}

function wireChannel(ch: RTCDataChannel): void {
  channel = ch
  ch.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as { type: string; text?: string; name?: string }
      if (msg.type === 'chat' && msg.text) {
        chatMessages.value = [...chatMessages.value, { id: ++chatId, from: 'peer', text: msg.text }]
      } else if (msg.type === 'hello' && msg.name) {
        peerName.value = msg.name
      }
    } catch {
      // 忽略无法解析的通道消息
    }
  }
  ch.onopen = () => channel?.send(JSON.stringify({ type: 'hello', name: selfName.value }))
}

function createPeer(initiator: boolean): RTCPeerConnection {
  const servers = iceServers(networkSettings.value)
  logDiagnostic('webrtc.peer.create', `initiator=${initiator} iceServers=${servers.length}`)
  const peer = new RTCPeerConnection({ iceServers: servers })
  const local = localStream.value
  if (local) {
    local.getTracks().forEach((t) => peer.addTrack(t, local))
  } else {
    // 无采集设备时保持可建连：显式声明只收不发
    peer.addTransceiver('audio', { direction: 'recvonly' })
    peer.addTransceiver('video', { direction: 'recvonly' })
  }
  peer.ontrack = (e) => {
    remoteStream.value = e.streams[0] ?? new MediaStream([e.track])
  }
  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState
    if (s === 'connected' || s === 'completed') {
      window.clearTimeout(disconnectTimer)
      window.clearTimeout(connectionTimer)
      window.clearTimeout(iceStallTimer)
      phase.value = 'connected'
      logDiagnostic('webrtc.ice.connected', `state=${s}`)
      inviteCode.value = ''
      replyCode.value = ''
      sasVerified.value = false
      void computeSas(peer.localDescription?.sdp ?? '', peer.remoteDescription?.sdp ?? '').then(
        (code) => (sasCode.value = code),
      )
    } else if (s === 'failed') {
      window.clearTimeout(connectionTimer)
      phase.value = 'failed'
      setStatus('P2P 连接失败，请检查网络或配置 TURN', 'error')
      logDiagnostic('webrtc.ice.failed', `state=${s}`, 'error')
    } else if (s === 'disconnected') {
      // 仅"已连接后"的掉线走 3 秒判定（测试矩阵 M-8）。
      // 建连阶段（connecting）的 disconnected 只是候选暂时不可达的抖动
      // ——对方可能还没粘贴回复码，此时挂断会杀死本可成功的通话，
      // 由连接计时器（邀请码 30 分钟 / 信号模式 120 秒）兜底。
      if (phase.value === 'connected') {
        logDiagnostic('webrtc.ice.disconnected', '3s 内未恢复将判定断开', 'warn')
        window.clearTimeout(disconnectTimer)
        disconnectTimer = window.setTimeout(() => {
          if (pc && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
            endCall('连接已断开（对方可能已退出）', false)
          }
        }, 3000)
      } else {
        logDiagnostic(
          'webrtc.ice.disconnected',
          `phase=${phase.value} 建立中抖动，10s 未恢复将按打洞失败处理`,
          'warn',
        )
        // 建连中断连且迟迟不恢复：快速给出可读的打洞失败提示，不再干等 120s 超时
        window.clearTimeout(iceStallTimer)
        iceStallTimer = window.setTimeout(() => {
          if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
            endCall(
              'P2P 打洞失败：双方候选无法互通（常见于对称 NAT、运营商拦截 UDP 或路由器 AP 隔离）。可尝试两台设备用同一 WiFi，或在设置页配置 TURN 中继',
              false,
            )
          }
        }, 10_000)
      }
    }
  }
  peer.ondatachannel = (e) => wireChannel(e.channel)
  peer.onicecandidate = (event) => {
    if (event.candidate && signal && signalRoom.value) {
      signal.send({ action: 'signal', type: 'ice', ice: event.candidate.toJSON() })
    }
  }
  // 数据通道只能由发起方创建，加入方通过 ondatachannel 接收，避免重复协商
  if (initiator) wireChannel(peer.createDataChannel('app'))
  return peer
}

function startConnectionTimer(timeoutMs: number, reason: string): void {
  window.clearTimeout(connectionTimer)
  connectionTimer = window.setTimeout(() => {
    if (pc && phase.value !== 'connected') {
      logDiagnostic('webrtc.connect.timeout', `timeoutSec=${Math.round(timeoutMs / 1000)} reason=${reason}`, 'error')
      endCall('连接超时，请检查信令服务器、STUN/TURN 和防火墙', false)
    }
  }, timeoutMs)
  logDiagnostic('webrtc.connect.timer', `timeoutSec=${Math.round(timeoutMs / 1000)} reason=${reason}`)
}

/** 候选地址统计：srflx 数量决定跨网能否打通，host 仅限同网段 */
function candidateStats(peer: RTCPeerConnection): string {
  const sdp = peer.localDescription?.sdp ?? ''
  const cands = sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'))
  const host = cands.filter((l) => l.includes('typ host')).length
  const srflx = cands.filter((l) => l.includes('typ srflx')).length
  const relay = cands.filter((l) => l.includes('typ relay')).length
  return `total=${cands.length} host=${host} srflx=${srflx} relay=${relay} sdpLen=${sdp.length}`
}

/** 非 trickle ICE：等待候选收集完成（超时兜底），保证邀请码自包含 */
function gatheringComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener('icegatheringstatechange', onChange)
      window.clearTimeout(timer)
      logDiagnostic('webrtc.gather', candidateStats(peer))
      resolve()
    }
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') done()
    }
    const timer = window.setTimeout(done, 15000)
    peer.addEventListener('icegatheringstatechange', onChange)
  })
}

async function ensureMedia(): Promise<void> {
  if (localStream.value) return
  try {
    logDiagnostic('media.request', 'audio=true video=true')
    localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  } catch {
    logDiagnostic('media.video.failed', 'falling back to audio', 'warn')
    try {
      localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
      setStatus('摄像头不可用，已切换为纯语音')
    } catch (e) {
      const name = (e as DOMException)?.name
      if (name === 'NotAllowedError') {
        setStatus('无法访问摄像头/麦克风：请检查 Windows 设置 → 隐私 → 相机/麦克风', 'error')
      } else {
        setStatus('未找到可用的摄像头/麦克风，将以只收模式加入')
      }
      logDiagnostic('media.audio.failed', `error=${name || 'unknown'}`, 'warn')
    }
  }
  const s = localStream.value
  micOn.value = !!s && s.getAudioTracks().length > 0
  camOn.value = !!s && s.getVideoTracks().length > 0
}

/** 发起方：默认走房间码模式（公共中继或自建信令），中继不可达时回退邀请码 */
async function createCall(): Promise<void> {
  if (pc) return
  role.value = 'caller'
  peerName.value = '对方'
  lanSetBusy(true)
  try {
    await createSignalCall()
    return
  } catch (e) {
    logDiagnostic('signal.create.error', e instanceof Error ? e.message : String(e), 'error')
    if (networkSettings.value.signalUrl) {
      // 自建服务器不可达：明确报错，不做静默降级
      endCall('信令房间创建失败，请检查服务器地址', false)
      throw e
    }
    // 公共中继不可达：自动回退邀请码模式（无需服务器的离线路径）
    endCall('公共信令中继不可用，已切换为邀请码模式', false)
  }
  beginCall('invite')
  try {
    await ensureMedia()
    const peer = createPeer(true)
    pc = peer
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await gatheringComplete(peer)
    inviteCode.value = await encodeInvite('o', peer.localDescription!.sdp)
    startConnectionTimer(MANUAL_HANDSHAKE_TIMEOUT_MS, 'manual-offer-waiting')
    logDiagnostic('invite.offer.ready', `sdpBytes=${peer.localDescription?.sdp.length ?? 0}`)
  } catch (e) {
    logDiagnostic('invite.offer.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('创建通话失败', false)
    throw e
  }
}

async function createSignalCall(): Promise<void> {
  role.value = 'caller'
  peerName.value = '对方'
  lanSetBusy(true)
  beginCall('signal')
  phase.value = 'connecting'
  signal = newSignalChannel()
  await signal.connect(networkSettings.value.signalUrl)
  // error 事件会同时打断多个等待中的 Promise，提前挂上 catch 避免 unhandled rejection
  const peerJoined = waitSignalMessage(signal, 'peer_joined', MANUAL_HANDSHAKE_TIMEOUT_MS)
  peerJoined.catch(() => {})
  signal.send({ action: 'create' })
  const createdMessage = await waitSignalMessage(signal, 'created')
  signalRoom.value = createdMessage.room ?? ''
  roomCode.value = `MV2-${signalRoom.value}`
  await ensureMedia()
  const peer = createPeer(true)
  pc = peer
  signalOff = signal.onMessage(async (message) => {
    if (message.type === 'answer' && message.sdp && pc) {
      await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
      await markRemoteReady()
      startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'signal-answer-received')
    } else if (message.type === 'ice' && message.ice && pc) {
      await applyRemoteIce(message.ice as RTCIceCandidateInit)
    } else if (message.type === 'bye') {
      endCall('对方已挂断', false)
    } else if (message.type === 'error') {
      endCall(message.error || '信令通道错误', false)
    }
  })
  // 等对方加入房间再发 offer：公共中继不缓存消息，早发的 offer 对方订阅前收不到
  await peerJoined
  const offer = await peer.createOffer()
  await peer.setLocalDescription(offer)
  signal.send({ action: 'signal', type: 'offer', sdp: offer.sdp })
  startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'signal-offer-sent')
}

/** 自建信令服务器优先，未配置时使用内置公共中继（无需自己的服务器） */
function newSignalChannel(): SignalingChannel {
  if (networkSettings.value.signalUrl) return new SignalConnection()
  return new PublicRelay()
}

async function joinSignalCall(code: string): Promise<void> {
  const room = code.trim().toUpperCase().replace(/^MV2-/, '')
  if (!/^[A-Z2-9]{6}$/.test(room)) throw new Error('房间码应为 6 位字符')
  role.value = 'callee'
  peerName.value = '对方'
  lanSetBusy(true)
  beginCall('signal')
  phase.value = 'connecting'
  signal = newSignalChannel()
  await signal.connect(networkSettings.value.signalUrl)
  signalRoom.value = room
  roomCode.value = `MV2-${room}`
  await ensureMedia()
  const peer = createPeer(false)
  pc = peer
  const offerPromise = waitSignalMessage(signal, 'offer', MANUAL_HANDSHAKE_TIMEOUT_MS)
  offerPromise.catch(() => {})
  // 主消息处理器先于 join 注册：对端在 offer 后立即 trickle 的候选不能丢（P1 修复）
  signalOff = signal.onMessage(async (message) => {
    if (message.type === 'ice' && message.ice && pc) {
      await applyRemoteIce(message.ice as RTCIceCandidateInit)
    } else if (message.type === 'bye') {
      endCall('对方已挂断', false)
    } else if (message.type === 'error') {
      endCall(message.error || '信令通道错误', false)
    }
  })
  signal.send({ action: 'join', room })
  await waitSignalMessage(signal, 'joined')
  // 迟到提示：MQTT 无房间存在性校验，加入空房间只会干等（如双方都点了加入会被中继冲突检测打断）
  joinHintTimer = window.setTimeout(() => {
    if (phase.value === 'connecting' && role.value === 'callee') {
      setStatus('仍无对方消息：请确认对方点击的是「创建新通话」并停留在等待界面', 'info')
    }
  }, 20_000)
  const offer = await offerPromise
  window.clearTimeout(joinHintTimer)
  await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp! })
  await markRemoteReady()
  const answer = await peer.createAnswer()
  await peer.setLocalDescription(answer)
  signal.send({ action: 'signal', type: 'answer', sdp: answer.sdp })
  startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'signal-answer-sent')
}

/** 发起方：粘贴对方的回复码后开始建连 */
async function acceptReplyCode(code: string): Promise<void> {
  if (!pc) throw new Error('请先创建通话')
  const parsed = await decodeInvite(code)
  if (parsed.kind !== 'a') throw new Error('这不是回复码，请粘贴对方回传的 MV1 回复码')
  phase.value = 'connecting'
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: parsed.sdp })
    startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'manual-answer-received')
    logDiagnostic('invite.answer.accepted', `sdpBytes=${parsed.sdp.length}`)
  } catch (e) {
    logDiagnostic('invite.answer.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('回复码无法建立连接', false)
    throw e
  }
}

/** 加入方：粘贴对方邀请码或 6 位房间码 */
async function joinWithInvite(code: string): Promise<void> {
  if (/^(?:MV2-)?[A-Z2-9]{6}$/i.test(code.trim())) {
    // 房间码：默认公共中继，未配置自建服务器也可直通
    try {
      await joinSignalCall(code)
    } catch (e) {
      logDiagnostic('signal.join.error', e instanceof Error ? e.message : String(e), 'error')
      endCall('加入信令房间失败，请检查房间码和网络', false)
      throw e
    }
    return
  }
  if (pc) return
  const parsed = await decodeInvite(code)
  if (parsed.kind !== 'o') throw new Error('请粘贴对方发起通话生成的邀请码')
  role.value = 'callee'
  peerName.value = '对方'
  lanSetBusy(true)
  phase.value = 'connecting'
  beginCall('invite')
  try {
    await ensureMedia()
    const peer = createPeer(false)
    pc = peer
    await peer.setRemoteDescription({ type: 'offer', sdp: parsed.sdp })
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    await gatheringComplete(peer)
    replyCode.value = await encodeInvite('a', peer.localDescription!.sdp)
    startConnectionTimer(MANUAL_HANDSHAKE_TIMEOUT_MS, 'manual-answer-waiting')
    logDiagnostic('invite.answer.ready', `sdpBytes=${peer.localDescription?.sdp.length ?? 0}`)
  } catch (e) {
    logDiagnostic('invite.answer.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('邀请码无法建立连接', false)
    throw e
  }
}

function toggleMic(): void {
  const tracks = localStream.value?.getAudioTracks() ?? []
  if (!tracks.length) return
  micOn.value = !micOn.value
  tracks.forEach((t) => (t.enabled = micOn.value))
}

function toggleCam(): void {
  const tracks = localStream.value?.getVideoTracks() ?? []
  if (!tracks.length) return
  camOn.value = !camOn.value
  tracks.forEach((t) => (t.enabled = camOn.value))
}

async function toggleShare(): Promise<void> {
  if (sharing.value) {
    await stopShare()
    return
  }
  const sender = pc?.getSenders().find((s) => s.track?.kind === 'video')
  if (!sender) {
    setStatus('当前没有视频通道，无法共享屏幕', 'error')
    return
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const track = display.getVideoTracks()[0]
    savedVideoSender = sender
    await sender.replaceTrack(track)
    shareStream.value = display
    sharing.value = true
    logDiagnostic('media.share.start')
    track.addEventListener('ended', () => void stopShare())
  } catch {
    // 用户取消选择窗口
  }
}

async function stopShare(): Promise<void> {
  if (savedVideoSender) {
    await savedVideoSender.replaceTrack(localStream.value?.getVideoTracks()[0] ?? null)
    savedVideoSender = null
  }
  shareStream.value?.getTracks().forEach((t) => t.stop())
  shareStream.value = null
  sharing.value = false
  logDiagnostic('media.share.stop')
}

/** 结束通话并复位状态；notifyPeer 决定是否通知对端（被动结束时不再回发 bye） */
function endCall(reason = '', notifyPeer = true): void {
  logDiagnostic(
    'call.end',
    `reason=${reason || 'local_hangup'} notify=${notifyPeer} phase=${phase.value} mode=${callMode ?? 'unknown'}`,
  )
  const wasConnected = phase.value === 'connected'
  const status = wasConnected ? 'completed' : reason ? 'failed' : 'cancelled'
  recordCall(status, reason)
  if (notifyPeer && lanCallId.value && lanPeerId.value) {
    void loadLan()
      .then((api) => api?.SendBye(lanPeerId.value, lanCallId.value))
      .catch(() => {})
  }
  lanSetBusy(false)
  window.clearTimeout(disconnectTimer)
  window.clearTimeout(connectionTimer)
  window.clearTimeout(joinHintTimer)
  window.clearTimeout(iceStallTimer)
  // 房间码模式下通知对端本端已挂断（P2 修复）：此前对端只能等 ICE disconnected 3s 兜底
  if (notifyPeer && signal && signalRoom.value) {
    try {
      signal.send({ action: 'bye' })
    } catch {
      // 信令连接可能已断开，对端走 ICE 超时兜底
    }
  }
  try {
    pc?.close()
  } catch {
    // 连接可能已经关闭
  }
  pc = null
  signalOff?.()
  signalOff = null
  signal?.close()
  signal = null
  channel = null
  savedVideoSender = null
  localStream.value?.getTracks().forEach((t) => t.stop())
  shareStream.value?.getTracks().forEach((t) => t.stop())
  localStream.value = null
  remoteStream.value = null
  shareStream.value = null
  sharing.value = false
  inviteCode.value = ''
  replyCode.value = ''
  roomCode.value = ''
  signalRoom.value = ''
  chatMessages.value = []
  peerName.value = '对方'
  role.value = null
  phase.value = 'idle'
  panel.value = 'none'
  lanPeerId.value = ''
  lanCallId.value = ''
  sasCode.value = ''
  sasVerified.value = false
  resetIceBuffer()
  if (reason) setStatus(reason, status === 'failed' ? 'error' : 'info')
  else statusMessage.value = ''
}

function hangup(): void {
  endCall('', true)
}

function sendChat(text: string): boolean {
  const t = text.trim()
  if (!t || !channel || channel.readyState !== 'open') return false
  channel.send(JSON.stringify({ type: 'chat', text: t }))
  chatMessages.value = [...chatMessages.value, { id: ++chatId, from: 'me', text: t }]
  return true
}

function setName(name: string): void {
  selfName.value = name.trim() || '本机'
  logDiagnostic('device.name.frontend', `nameBytes=${selfName.value.length}`)
  localStorage.setItem('mv:name', selfName.value)
  if (channel && channel.readyState === 'open') {
    channel.send(JSON.stringify({ type: 'hello', name: selfName.value }))
  }
  void loadLan()
    .then((api) => api?.SetName(selfName.value))
    .catch(() => {})
}

function setNetworkSettings(settings: NetworkSettings): void {
  networkSettings.value = saveNetworkSettings(settings)
  logDiagnostic('network.settings', `stun=${networkSettings.value.stunUrls.length} turn=${networkSettings.value.turnUrl ? 'configured' : 'off'}`)
}

function lanSetBusy(busy: boolean): void {
  void loadLan()
    .then((api) => api?.SetBusy(busy))
    .catch(() => {})
}

/** 主动向指定 IPv4 发起局域网发现（广播被 AP 隔离/跨网段时的兜底） */
async function connectIP(ip: string): Promise<void> {
  logDiagnostic('lan.connect_ip.frontend', `ip=${ip}`)
  const api = await loadLan()
  if (!api) return
  await api.ConnectIP(ip) // 错误抛给调用方展示
}

/** 读取剪贴板文本（供"从剪贴板填充"按钮使用，失败返回空串） */
async function pasteFromClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim()
  } catch {
    return ''
  }
}

/**
 * 启动时检测一次剪贴板中的邀请码（仅桌面端，不做持续监听）。
 * 主叫等待自己邀请码被复制时不会误触发（role 已非空）。
 */
async function checkClipboardInvite(): Promise<void> {
  if (role.value !== null || phase.value !== 'idle') return
  const text = await pasteFromClipboard()
  if (!text.startsWith('MV1-') || text === inviteCode.value || text === detectedInvite.value) {
    return
  }
  detectedInvite.value = text
}

/** 加入剪贴板中检测到的邀请码 */
async function joinDetected(): Promise<void> {
  const code = detectedInvite.value
  if (!code) return
  detectedInvite.value = ''
  try {
    await joinWithInvite(code)
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '邀请码无法解析', 'error')
  }
}

function dismissDetected(): void {
  detectedInvite.value = ''
}

/** 订阅局域网事件并同步本机设备信息；浏览器环境静默跳过 */
async function initLan(): Promise<void> {
  logDiagnostic('lan.init.begin')
  try {
    if (!(await waitDesktop())) {
      lanStatus.value = 'off'
      logDiagnostic('lan.init.skip', 'desktop runtime unavailable', 'warn')
      return
    }
    const api = await loadLan()
    const rt = await loadRuntime()
    if (!api || !rt) {
      lanStatus.value = 'off'
      logDiagnostic('lan.init.skip', 'bindings unavailable', 'warn')
      return
    }
    try {
      const info = await api.Info()
      if (info?.name) {
        selfName.value = info.name
        localStorage.setItem('mv:name', info.name)
      }
      selfIPs.value = (info?.ips as string[]) ?? []
    } catch {
      // Info 失败不影响事件订阅
    }
    lanReady.value = true
    lanStatus.value = 'ready'
  rt.Events.On('lan:peers', (ev: unknown) => {
    const data = (ev as { data?: LanPeer[] }).data ?? []
    lanPeers.value = Array.isArray(data) ? data : []
    logDiagnostic('lan.peers', `count=${lanPeers.value.length}`)
  })
  rt.Events.On('lan:incoming', (ev: unknown) => {
    const incoming = (ev as { data?: LanIncoming }).data
    if (!incoming?.callId) return
    if (lanIncoming.value?.callId === incoming.callId) return
    if (lanIncoming.value || role.value !== null) {
      logDiagnostic('lan.incoming.rejected', `call=${incoming.callId} reason=busy`, 'warn')
      void loadLan()
        .then((api) => api?.DeclineCall(incoming.from, incoming.callId))
        .catch(() => {})
      return
    }
    lanIncoming.value = incoming
    logDiagnostic('lan.incoming', `call=${incoming.callId}`)
  })
  rt.Events.On('lan:answer', (ev: unknown) => {
    const d = (ev as { data?: { callId?: string; sdp?: string } }).data
    void handleLanAnswer(d?.callId ?? '', d?.sdp ?? '')
  })
  rt.Events.On('lan:decline', (ev: unknown) => {
    handleLanEnd((ev as { data?: { callId?: string } }).data?.callId, '对方已拒绝')
  })
  rt.Events.On('lan:timeout', (ev: unknown) => {
    handleLanEnd((ev as { data?: { callId?: string } }).data?.callId, '对方无应答')
  })
  rt.Events.On('lan:bye', (ev: unknown) => {
    const callId = (ev as { data?: { callId?: string } }).data?.callId
    if (callId && callId === lanCallId.value) {
      lanCallId.value = ''
      lanPeerId.value = ''
      endCall('对方已挂断', false)
    }
  })
  // 桌面端：仅启动时检测一次剪贴板邀请码（不做持续监听，之后用「从剪贴板填充」按钮）
  void checkClipboardInvite()
  } catch (e) {
    lanStatus.value = 'error: ' + (e instanceof Error ? e.message : String(e))
    logDiagnostic('lan.init.error', e instanceof Error ? e.message : String(e), 'error')
  }
}

/** 点击附近设备发起局域网呼叫 */
async function startLanCall(peer: LanPeer): Promise<void> {
  if (pc || role.value !== null || lanCallId.value) return
  role.value = 'caller'
  peerName.value = peer.name
  lanPeerId.value = peer.id
  lanCallId.value = crypto.randomUUID()
  lanSetBusy(true)
  phase.value = 'connecting'
  try {
    beginCall('lan')
    await ensureMedia()
    const p = createPeer(true)
    pc = p
    const offer = await p.createOffer()
    await p.setLocalDescription(offer)
    await gatheringComplete(p)
    const api = await loadLan()
    if (!api) throw new Error('桌面端不可用')
    await api.SendOffer(peer.id, lanCallId.value, p.localDescription!.sdp)
    startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'lan-offer-sent')
    logDiagnostic('lan.offer.sent', `peer=${peer.id} sdpBytes=${p.localDescription?.sdp.length ?? 0}`)
  } catch (e) {
    logDiagnostic('lan.offer.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('呼叫发送失败', false)
  }
}

/** 接听来电 */
async function acceptLanCall(): Promise<void> {
  const inc = lanIncoming.value
  if (!inc || pc || role.value !== null) return
  lanIncoming.value = null
  role.value = 'callee'
  peerName.value = inc.name
  lanPeerId.value = inc.from
  lanCallId.value = inc.callId
  lanSetBusy(true)
  phase.value = 'connecting'
  let p: RTCPeerConnection | null = null
  try {
    beginCall('lan')
    await ensureMedia()
    p = createPeer(false)
    pc = p
    await p.setRemoteDescription({ type: 'offer', sdp: inc.sdp })
    const answer = await p.createAnswer()
    await p.setLocalDescription(answer)
    await gatheringComplete(p)
  } catch (e) {
    logDiagnostic('lan.answer.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('来电信息无效', false)
    return
  }
  const api = await loadLan()
  if (!api) {
    endCall('桌面端不可用', false)
    return
  }
  try {
    await api.AcceptCall(inc.from, inc.callId, p!.localDescription!.sdp)
    startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'lan-answer-sent')
    logDiagnostic('lan.answer.sent', `peer=${inc.from} sdpBytes=${p!.localDescription?.sdp.length ?? 0}`)
  } catch (e) {
    logDiagnostic('lan.answer.send.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('应答发送失败', false)
  }
}

/** 拒绝来电 */
async function declineLanCall(): Promise<void> {
  const inc = lanIncoming.value
  if (!inc) return
  lanIncoming.value = null
  const api = await loadLan()
  void api
    ?.DeclineCall(inc.from, inc.callId)
    .catch(() => {})
}

async function handleLanAnswer(callId: string, sdp: string): Promise<void> {
  if (!callId || callId !== lanCallId.value || !pc) return
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp })
    startConnectionTimer(WEBRTC_CONNECT_TIMEOUT_MS, 'lan-answer-received')
    logDiagnostic('lan.answer.received', `sdpBytes=${sdp.length}`)
  } catch (e) {
    logDiagnostic('lan.answer.parse.error', e instanceof Error ? e.message : String(e), 'error')
    endCall('对方的应答无法解析', true)
  }
}

function handleLanEnd(callId: string | undefined, reason: string): void {
  if (!callId || callId !== lanCallId.value) return
  lanCallId.value = ''
  lanPeerId.value = ''
  endCall(reason, false)
}

/** 全局唯一的通话 store（reactive 包装使模板中可直接读写） */
export const call = reactive({
  phase,
  statusMessage,
  statusTone,
  role,
  inCall,
  participants,
  localStream,
  remoteStream,
  shareStream,
  micOn,
  camOn,
  sharing,
  inviteCode,
  replyCode,
  roomCode,
  signalRoom,
  panel,
  peerName,
  selfName,
  selfIPs,
  networkSettings,
  chatMessages,
  detectedInvite,
  lanPeers,
  lanIncoming,
  lanReady,
  lanStatus,
  sasCode,
  sasVerified,
  createCall,
  joinWithInvite,
  acceptReplyCode,
  startLanCall,
  acceptLanCall,
  declineLanCall,
  connectIP,
  joinDetected,
  dismissDetected,
  pasteFromClipboard,
  initLan,
  toggleMic,
  toggleCam,
  toggleShare,
  hangup,
  sendChat,
  setName,
  setNetworkSettings,
  setStatus,
})

export type CallStore = typeof call

export function useCall(): CallStore {
  return call
}
