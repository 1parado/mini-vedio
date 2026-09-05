// mini-vedio PWA Service Worker
// 策略：安装时预缓存入口；运行时对同源 GET 采用「缓存优先、后台回填」，
// 导航请求网络优先（保证发版后能拿到新页面），离线时回退缓存的 index.html。
// 通话媒体走 WebRTC P2P，不经 Service Worker；信令邀请码为纯前端计算，
// 因此页面离线打开后依然可以发起/加入跨网通话（STUN/TURN 需要网络）。

const CACHE = 'mv-pwa-v1'
const PRECACHE = ['./', './index.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 导航请求：网络优先，成功则刷新缓存的入口；失败（离线）回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('./index.html')),
    )
    return
  }

  // 静态资源：缓存优先，未命中时拉网络并回填
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {})
          }
          return res
        }),
    ),
  )
})
