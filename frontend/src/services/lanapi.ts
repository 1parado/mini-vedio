// 桌面端（Wails）能力的惰性加载封装。
// 浏览器直接访问时 isDesktop() 为 false，所有加载返回 null，调用方按"无局域网"模式降级。
export type LanBindings = typeof import('../../../bindings/mini-vedio/lanservice.js')
export type WailsRuntime = typeof import('@wailsio/runtime')

let bindings: LanBindings | null = null
let runtime: WailsRuntime | null = null

/** 是否运行在 Wails 桌面壳内（运行时会先于页面注入 window._wails 标志） */
export function isDesktop(): boolean {
  return typeof (window as unknown as { _wails?: object })._wails !== 'undefined'
}

/** 等待桌面运行时标志出现（注入可能晚于页面脚本执行） */
export async function waitDesktop(timeoutMs = 5000): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (isDesktop()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** 加载 Go 绑定（LanService），仅桌面端可用 */
export async function loadLan(): Promise<LanBindings | null> {
  if (!isDesktop()) return null
  bindings ??= await import('../../../bindings/mini-vedio/lanservice.js')
  return bindings
}

/** 加载 Wails 运行时（事件订阅等） */
export async function loadRuntime(): Promise<WailsRuntime | null> {
  if (!isDesktop()) return null
  runtime ??= await import('@wailsio/runtime')
  return runtime
}
