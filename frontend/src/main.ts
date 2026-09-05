import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { isDesktop } from './services/lanapi'
import { logDiagnostic } from './services/diagnostics'

createApp(App).mount('#app')

// PWA：仅在浏览器安全上下文注册 Service Worker。
// 桌面壳（Wails）与 http 明文环境跳过，避免影响单文件 exe 的启动路径。
if (
  !isDesktop() &&
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => logDiagnostic('pwa.sw.registered', `scope=${reg.scope}`))
      .catch((err: unknown) =>
        logDiagnostic('pwa.sw.register_failed', String(err).slice(0, 120), 'warn'),
      )
  })
}
