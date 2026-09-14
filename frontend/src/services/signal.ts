import { logDiagnostic } from './diagnostics'

export interface SignalMessage {
  type: 'created' | 'joined' | 'peer_joined' | 'offer' | 'answer' | 'ice' | 'bye' | 'error'
  room?: string
  sdp?: string
  ice?: unknown
  error?: string
}

/**
 * 信令通道统一接口：自建 WSS 服务器（SignalConnection）与
 * 公共中继（PublicRelay，无需自己的服务器）都按此协议实现，
 * 通话状态机不感知底层差异。
 */
export interface SignalingChannel {
  connect(url: string): Promise<void>
  onMessage(listener: (message: SignalMessage) => void): () => void
  send(message: Record<string, unknown>): void
  close(): void
}

export class SignalConnection implements SignalingChannel {
  private socket: WebSocket | null = null
  private listeners = new Set<(message: SignalMessage) => void>()

  async connect(url: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    logDiagnostic('signal.connect.begin', `url=${url.replace(/\/\/.+@/, '//redacted@')}`)
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket
      const timer = window.setTimeout(() => {
        socket.close()
        reject(new Error('信令服务器连接超时，请检查地址和网络'))
      }, 15_000)
      socket.onopen = () => {
        window.clearTimeout(timer)
        logDiagnostic('signal.connect.ok')
        resolve()
      }
      socket.onerror = () => {
        window.clearTimeout(timer)
        logDiagnostic('signal.connect.error', 'websocket error', 'error')
        reject(new Error('信令服务器连接失败，请检查地址和网络'))
      }
      socket.onclose = () => {
        window.clearTimeout(timer)
        this.socket = null
        logDiagnostic('signal.connect.close', 'connection closed', 'warn')
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as SignalMessage
          this.listeners.forEach((listener) => listener(message))
        } catch {
          logDiagnostic('signal.message.reject', 'invalid JSON', 'warn')
        }
      }
    })
  }

  onMessage(listener: (message: SignalMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('信令连接尚未建立')
    logDiagnostic('signal.send', `type=${String(message.type ?? message.action ?? 'unknown')}`)
    this.socket.send(JSON.stringify(message))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
    this.listeners.clear()
  }
}

export function waitSignalMessage(
  connection: SignalingChannel,
  type: SignalMessage['type'],
  timeoutMs = 60_000,
): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      off()
      reject(new Error('等待信令消息超时，请重新创建或加入房间'))
    }, timeoutMs)
    const off = connection.onMessage((message) => {
      if (message.type === 'error') {
        window.clearTimeout(timer)
        off()
        reject(new Error(message.error || '信令服务器返回错误'))
      } else if (message.type === type) {
        window.clearTimeout(timer)
        off()
        resolve(message)
      }
    })
  })
}
