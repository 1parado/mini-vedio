export interface NetworkSettings {
  stunUrls: string[]
  turnUrl: string
  turnUsername: string
  turnCredential: string
}

const STORAGE_KEY = 'mv:network-settings'
const SESSION_CREDENTIAL_KEY = 'mv:turn-credential'
const DEFAULTS: NetworkSettings = {
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
}

export function loadNetworkSettings(): NetworkSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<NetworkSettings>
    const sessionCredential = sessionStorage.getItem(SESSION_CREDENTIAL_KEY) ?? ''
    if (typeof parsed.turnCredential === 'string' && parsed.turnCredential) {
      // 清理旧版本曾写入 localStorage 的明文凭据。
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...parsed, turnCredential: '' }))
    }
    return {
      stunUrls: Array.isArray(parsed.stunUrls) && parsed.stunUrls.length ? parsed.stunUrls.filter(Boolean) : [...DEFAULTS.stunUrls],
      turnUrl: typeof parsed.turnUrl === 'string' ? parsed.turnUrl : '',
      turnUsername: typeof parsed.turnUsername === 'string' ? parsed.turnUsername : '',
      // TURN 密码不从持久化 localStorage 读取，只在本次应用会话中保留。
      turnCredential: sessionCredential,
    }
  } catch {
    return { ...DEFAULTS, stunUrls: [...DEFAULTS.stunUrls] }
  }
}

export function saveNetworkSettings(settings: NetworkSettings): NetworkSettings {
  const normalized: NetworkSettings = {
    stunUrls: settings.stunUrls.map((url) => url.trim()).filter(Boolean),
    turnUrl: settings.turnUrl.trim(),
    turnUsername: settings.turnUsername.trim(),
    turnCredential: settings.turnCredential,
  }
  if (!normalized.stunUrls.length) normalized.stunUrls = [...DEFAULTS.stunUrls]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...normalized, turnCredential: '' }))
    if (normalized.turnCredential) sessionStorage.setItem(SESSION_CREDENTIAL_KEY, normalized.turnCredential)
    else sessionStorage.removeItem(SESSION_CREDENTIAL_KEY)
  } catch {
    // 存储不可用时继续使用本次配置。
  }
  return normalized
}

export function iceServers(settings = loadNetworkSettings()): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: settings.stunUrls }]
  if (settings.turnUrl) {
    servers.push({ urls: settings.turnUrl, username: settings.turnUsername, credential: settings.turnCredential })
  }
  return servers
}
