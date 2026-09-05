import { loadLan } from './lanapi'

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticEntry {
  ts: string
  level: DiagnosticLevel
  event: string
  detail?: string
}

const STORAGE_KEY = 'mv:diagnostics'
const MAX_LOCAL_ENTRIES = 300

function readLocal(): DiagnosticEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as DiagnosticEntry[]) : []
  } catch {
    return []
  }
}

function writeLocal(entries: DiagnosticEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LOCAL_ENTRIES)))
  } catch {
    // 隐私模式或存储配额不足时，仍允许通话继续。
  }
}

export function logDiagnostic(
  event: string,
  detail = '',
  level: DiagnosticLevel = 'info',
): void {
  const entry: DiagnosticEntry = {
    ts: new Date().toISOString(),
    level,
    event: event.slice(0, 80),
    detail: detail.slice(0, 500),
  }
  writeLocal([...readLocal(), entry])

  void loadLan()
    .then((api) => api?.LogDiagnostic(level, entry.event, entry.detail ?? ''))
    .catch(() => {
      // 桌面绑定不可用时保留 localStorage 副本。
    })
}

function localAsJSONL(): string {
  return readLocal().map((entry) => JSON.stringify(entry)).join('\n')
}

export async function exportDiagnostics(): Promise<void> {
  let content = localAsJSONL()
  try {
    const api = await loadLan()
    const persisted = await api?.ReadDiagnostics()
    if (persisted) content = persisted
  } catch {
    // 浏览器模式或桌面服务不可用时导出本地副本。
  }
  if (!content) content = JSON.stringify({ error: '暂无诊断日志' })

  const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mini-vedio-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  logDiagnostic('diagnostics.export', `bytes=${content.length}`)
}

export function clearDiagnostics(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略本地存储不可用。
  }
  void loadLan()
    .then((api) => api?.ClearDiagnostics())
    .catch(() => {})
}
