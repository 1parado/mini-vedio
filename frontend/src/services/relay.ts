import { logDiagnostic } from './diagnostics'
import type { SignalMessage, SignalingChannel } from './signal'

/**
 * 公共中继信令（无需自建服务器）。
 *
 * 协议：MQTT 3.1.1 over WebSocket（纯 Web 标准 API 手写报文，零依赖，仅 ~200 行）。
 * 原方案是公共 Nostr 中继，但 NIP-01 要求 secp256k1 Schnorr 签名，前端无法在
 * 不引运行时库的前提下轻量实现（违反 §11"不引入运行时库"）；公共 MQTT broker
 * 同样是免注册的公共基础设施，达成同样的"房间码即通"目标。
 *
 * 安全边界：broker 只搬运 SDP/ICE 文本，媒体仍由 WebRTC DTLS-SRTP 端到端加密；
 * 信令通道被 broker 运营方看到不破坏机密性，身份防伪由 SAS 核对码兜底（AGENTS.md §6）。
 * 日志只记录 broker 名、房间、消息类型与载荷长度，不记录 SDP/ICE 内容（C7）。
 */

/** 免费公共 broker，按序尝试；均为社区公开服务，可能变更——失败会自动回退邀请码模式 */
const RELAY_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt']

/**
 * broker 选择器：公共 broker 之间互不相通，主叫与被叫必须落在同一台 broker 上。
 * 约定房间码首字符编码 broker 下标（A → RELAY_BROKERS[0]，B → [1]，以此类推），
 * 双方各自按房间码确定性选 broker，无需额外协商通道。
 */
const BROKER_SELECTOR = 'AB'

const TOPIC_ROOT = 'mv-rtc1'
const CONNECT_TIMEOUT_MS = 10_000
const SUBACK_TIMEOUT_MS = 10_000
const KEEPALIVE_SEC = 60
const PING_INTERVAL_MS = 45_000
const MAX_PAYLOAD_BYTES = 64 * 1024
/** 房间码主体字母表与 signal.go newRoomCode 一致（去除易混淆字符） */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 对端订阅完成存在竞态：join 在途广播在对方 SUBACK 前发出会丢，重发兜底 */
const JOIN_RETRY_INTERVAL_MS = 4_000
const JOIN_RETRY_MAX = 450

/** 公共中继房间码：首字符 = broker 选择符，后 5 位随机 */
const RELAY_ROOM_PATTERN = /^[AB][A-Z2-9]{5}$/

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function mqttString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 2)
  out[0] = (bytes.length >> 8) & 0xff
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

/** MQTT 剩余长度变长编码（MQTT 3.1.1 §2.2.3） */
function encodeRemainingLength(length: number): number[] {
  const out: number[] = []
  let n = length
  do {
    let digit = n % 128
    n = Math.floor(n / 128)
    if (n > 0) digit |= 0x80
    out.push(digit)
  } while (n > 0)
  return out
}

function newRoomCode(brokerIdx: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(5))
  let body = ''
  for (const b of raw) body += ROOM_ALPHABET[b % ROOM_ALPHABET.length]
  return BROKER_SELECTOR[brokerIdx] + body
}

export class PublicRelay implements SignalingChannel {
  private ws: WebSocket | null = null
  private broker = ''
  private readonly clientId = 'mv' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  private readonly senderId = Math.random().toString(36).slice(2, 10)
  private listeners = new Set<(message: SignalMessage) => void>()
  private packetId = 0
  private pingTimer: number | undefined
  private joinTimer: number | undefined
  private createdRoom = false
  private roomJoined = false
  private activeRoom = ''
  private peerJoinedEmitted = false

  /**
   * 公共中继无需在此预连接：broker 由房间码首字符确定性选择，
   * 建房（create）与进房（join）时才建立连接，失败通过 error 事件上报。
   */
  async connect(): Promise<void> {
    logDiagnostic('relay.connect.begin', 'mode=public')
  }

  private connectBroker(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url, ['mqtt'])
      } catch {
        reject(new Error('地址无效'))
        return
      }
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      const timer = window.setTimeout(() => {
        cleanup()
        if (this.ws === ws) this.ws = null
        reject(new Error('连接超时'))
      }, CONNECT_TIMEOUT_MS)
      const cleanup = () => {
        window.clearTimeout(timer)
        ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null
      }
      ws.onopen = () => {
        const cid = encodeUtf8(this.clientId)
        const body = new Uint8Array([
          0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, (KEEPALIVE_SEC >> 8) & 0xff, KEEPALIVE_SEC & 0xff,
          ...mqttString(cid),
        ])
        ws.send(Uint8Array.from([0x10, ...encodeRemainingLength(body.length), ...body]))
      }
      ws.onerror = () => {
        cleanup()
        if (this.ws === ws) this.ws = null
        reject(new Error('连接失败'))
      }
      ws.onclose = () => {
        cleanup()
        if (this.ws === ws) this.ws = null
        reject(new Error('连接已关闭'))
      }
      ws.onmessage = (event) => {
        const view = new DataView(event.data as ArrayBuffer)
        const type = view.getUint8(0) >> 4
        if (type === 2) {
          // CONNACK：会话建立成功，启动保活
          cleanup()
          window.clearInterval(this.pingTimer)
          this.pingTimer = window.setInterval(() => this.sendRaw([0xc0, 0x00]), PING_INTERVAL_MS)
          ws.onmessage = (ev) => this.handlePacket(ev.data as ArrayBuffer)
          ws.onclose = () => this.handleClose()
          resolve()
        }
      }
    })
  }

  private handleClose(): void {
    this.ws = null
    this.stopJoinRetry()
    window.clearInterval(this.pingTimer)
    logDiagnostic('relay.connect.close', `broker=${brokerHost(this.broker)}`, 'warn')
    // 通话中被断开：转为 error 让状态机给出可读提示
    if (this.roomJoined) {
      this.emit({ type: 'error', error: '公共信令中继连接已断开，请重试或改用邀请码模式' })
    }
  }

  private emit(message: SignalMessage): void {
    this.listeners.forEach((listener) => listener(message))
  }

  onMessage(listener: (message: SignalMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) throw new Error('信令连接尚未建立')
    const action = String(message.action ?? '')
    if (action === 'create') {
      // 发起方：依次尝试 broker，成功后生成携带 broker 标识的房间码
      void this.setupCreate()
      return
    }
    if (action === 'join') {
      void this.setupJoin(String(message.room ?? ''))
      return
    }
    if (action === 'signal') {
      this.publish(JSON.stringify({ type: message.type, sdp: message.sdp, ice: message.ice }))
      return
    }
    if (action === 'bye') {
      this.publish(JSON.stringify({ type: 'bye' }))
      return
    }
    throw new Error('未知信令操作')
  }

  /** 建房：逐个尝试公共 broker，连接成功即用该 broker 建房 */
  private async setupCreate(): Promise<void> {
    for (let idx = 0; idx < RELAY_BROKERS.length; idx += 1) {
      try {
        await this.openBroker(idx)
      } catch (e) {
        logDiagnostic('relay.connect.fail', `broker=${brokerHost(RELAY_BROKERS[idx])} reason=${e instanceof Error ? e.message : String(e)}`, 'warn')
        continue
      }
      try {
        await this.subscribeRoom(newRoomCode(idx))
      } catch (e) {
        this.emit({ type: 'error', error: e instanceof Error ? e.message : '订阅房间失败' })
        return
      }
      this.createdRoom = true
      this.roomJoined = true
      logDiagnostic('relay.connect.ok', `broker=${brokerHost(this.broker)}`)
      this.emit({ type: 'created', room: this.activeRoom })
      return
    }
    this.emit({
      type: 'error',
      error: '公共信令中继不可用，已切换为邀请码模式；也可在设置中配置自建信令服务器',
    })
  }

  /** 进房：按房间码首字符连接对应 broker（双方必须落在同一台 broker） */
  private async setupJoin(roomCode: string): Promise<void> {
    const room = roomCode.trim().toUpperCase()
    if (!RELAY_ROOM_PATTERN.test(room)) {
      this.emit({ type: 'error', error: '房间码格式不正确（应为 6 位字符，首字符为 A/B）' })
      return
    }
    const idx = BROKER_SELECTOR.indexOf(room[0])
    try {
      await this.openBroker(idx)
    } catch (e) {
      this.emit({ type: 'error', error: `公共信令中继连接失败（${e instanceof Error ? e.message : String(e)}）` })
      return
    }
    try {
      await this.subscribeRoom(room)
    } catch (e) {
      this.emit({ type: 'error', error: e instanceof Error ? e.message : '订阅房间失败' })
      return
    }
    this.roomJoined = true
    logDiagnostic('relay.connect.ok', `broker=${brokerHost(this.broker)}`)
    this.emit({ type: 'joined', room })
    this.startJoinRetry()
  }

  private async openBroker(idx: number): Promise<void> {
    if (idx < 0 || idx >= RELAY_BROKERS.length) {
      throw new Error('房间码指向的中继不可识别')
    }
    this.broker = RELAY_BROKERS[idx]
    await this.connectBroker(this.broker)
  }

  private async subscribeRoom(room: string): Promise<void> {
    await this.subscribe(`${TOPIC_ROOT}/${room}/#`)
  }

  private stopJoinRetry(): void {
    window.clearInterval(this.joinTimer)
    this.joinTimer = undefined
  }

  private startJoinRetry(): void {
    this.stopJoinRetry()
    let attempts = 0
    this.joinTimer = window.setInterval(() => {
      attempts += 1
      if (attempts > JOIN_RETRY_MAX) {
        this.stopJoinRetry()
        return
      }
      logDiagnostic('relay.join.retry', `attempt=${attempts}`)
      this.publish(JSON.stringify({ type: 'join' }))
    }, JOIN_RETRY_INTERVAL_MS)
  }

  private publish(payload: string): void {
    const bytes = encodeUtf8(payload)
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      logDiagnostic('relay.publish.reject', `bytes=${bytes.length} reason=too_large`, 'warn')
      return
    }
    const topic = mqttString(encodeUtf8(`${TOPIC_ROOT}/${this.activeRoom}/${this.senderId}`))
    const body = new Uint8Array([...topic, ...bytes])
    this.sendRaw([0x30, ...encodeRemainingLength(body.length), ...body])
    logDiagnostic('relay.publish', `type=${safeType(payload)} bytes=${bytes.length}`)
  }

  private async subscribe(filter: string): Promise<void> {
    this.activeRoom = filter.split('/')[1] ?? ''
    const pid = ++this.packetId
    const body = new Uint8Array([
      (pid >> 8) & 0xff, pid & 0xff,
      ...mqttString(encodeUtf8(filter)),
      0x00, // QoS 0
    ])
    const done = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('订阅房间超时')), SUBACK_TIMEOUT_MS)
      const off = this.onRaw((view) => {
        if (view.getUint8(0) >> 4 === 9) {
          window.clearTimeout(timer)
          off()
          resolve()
        }
      })
    })
    this.sendRaw([0x82, ...encodeRemainingLength(body.length), ...body])
    await done
    logDiagnostic('relay.subscribe', `room=${this.activeRoom}`)
  }

  private rawListeners = new Set<(view: DataView) => void>()

  private onRaw(listener: (view: DataView) => void): () => void {
    this.rawListeners.add(listener)
    return () => this.rawListeners.delete(listener)
  }

  private handlePacket(buffer: ArrayBuffer): void {
    try {
      const view = new DataView(buffer)
      const type = view.getUint8(0) >> 4
      // 先喂给底层监听（SUBACK 等）
      this.rawListeners.forEach((listener) => listener(view))
      if (type !== 3) return // 只处理 PUBLISH
      let offset = 1
      // 跳过剩余长度（变长编码，取值本身不需要）
      while (true) {
        const byte = view.getUint8(offset)
        offset += 1
        if ((byte & 0x80) === 0) break
      }
      const topicLen = view.getUint16(offset)
      offset += 2
      const topic = new TextDecoder().decode(new Uint8Array(buffer, offset, topicLen))
      offset += topicLen
      if (((view.getUint8(0) >> 1) & 0x03) > 0) offset += 2 // QoS>0 带报文标识符（本客户端不会订阅 QoS>0）
      const payload = new TextDecoder().decode(new Uint8Array(buffer, offset))
      this.handlePublish(topic, payload)
    } catch (e) {
      logDiagnostic('relay.packet.reject', e instanceof Error ? e.message : 'malformed packet', 'warn')
    }
  }

  private handlePublish(topic: string, payload: string): void {
    const segments = topic.split('/')
    const sender = segments[2] ?? ''
    if (sender === this.senderId) return // broker 会回显自己的发布，按发送者过滤
    // 'join' 是仅在链路上出现的类型（对端重发去重后不透传给状态机）
    type WireType = SignalMessage['type'] | 'join'
    let message: { type?: WireType; sdp?: string; ice?: unknown; error?: string }
    try {
      message = JSON.parse(payload) as { type?: WireType; sdp?: string; ice?: unknown; error?: string }
    } catch {
      logDiagnostic('relay.message.reject', 'invalid JSON', 'warn')
      return
    }
    if (message.type === 'join') {
      // 加入广播会重发多次，只向上层报一次（对端重复收报会污染诊断日志）
      if (!this.peerJoinedEmitted) {
        this.peerJoinedEmitted = true
        this.emit({ type: 'peer_joined' })
      }
      return
    }
    if (message.type === 'offer') {
      this.stopJoinRetry() // 收到 offer 说明对端已就绪，停止 join 重发
    }
    logDiagnostic('relay.message', `type=${String(message.type)}`)
    if (!message.type) {
      logDiagnostic('relay.message.reject', 'missing type', 'warn')
      return
    }
    this.emit({ type: message.type, sdp: message.sdp, ice: message.ice, error: message.error })
  }

  private sendRaw(bytes: number[]): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('信令连接尚未建立')
    ws.send(Uint8Array.from(bytes))
  }

  close(): void {
    this.stopJoinRetry()
    window.clearInterval(this.pingTimer)
    this.rawListeners.clear()
    this.listeners.clear()
    if (this.ws) {
      // MQTT DISCONNECT 报文：优雅下线
      try {
        this.sendRaw([0xe0, 0x00])
      } catch {
        // 连接可能已断开
      }
      this.ws.close()
      this.ws = null
    }
  }
}

function brokerHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function safeType(payload: string): string {
  try {
    return String((JSON.parse(payload) as { type?: unknown }).type ?? 'unknown')
  } catch {
    return 'unknown'
  }
}
