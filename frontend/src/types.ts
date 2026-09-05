/** 通话生命周期阶段（驱动全局 UI 状态） */
export type CallPhase = 'idle' | 'connecting' | 'connected' | 'failed' | 'ended'

/** 手动信令载荷类型：o = offer（邀请码），a = answer（回复码） */
export type InviteKind = 'o' | 'a'

export interface ChatMessage {
  id: number
  from: 'me' | 'peer'
  text: string
}

export interface Participant {
  id: 'self' | 'peer'
  name: string
  connected: boolean
}

export type CallRecordStatus = 'completed' | 'failed' | 'cancelled'

export interface CallRecord {
  id: string
  peerName: string
  mode: 'invite' | 'lan'
  status: CallRecordStatus
  startedAt: string
  endedAt: string
  durationSec: number
  reason?: string
}

export interface Contact {
  id: string
  name: string
  ip?: string
  peerId?: string
  createdAt: string
  updatedAt: string
}
