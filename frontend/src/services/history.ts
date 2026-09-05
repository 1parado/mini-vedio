import type { CallRecord, CallRecordStatus } from '../types'

const STORAGE_KEY = 'mv:call-records'
const MAX_RECORDS = 200

function read(): CallRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as CallRecord[]) : []
  } catch {
    return []
  }
}

export function listCallRecords(): CallRecord[] {
  return read().sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function addCallRecord(record: Omit<CallRecord, 'id'>): void {
  const next: CallRecord = { ...record, id: crypto.randomUUID() }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([next, ...read()].slice(0, MAX_RECORDS)))
  } catch {
    // 本地存储不可用时不影响通话。
  }
}

export function clearCallRecords(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略本地存储不可用。
  }
}

export function statusLabel(status: CallRecordStatus): string {
  return status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '已取消'
}
