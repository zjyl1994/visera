/* Visera PWA service worker. Keep authenticated JSON and mutations off disk. */
const SHELL_CACHE = 'visera-shell-v4'
const IMAGE_CACHE = 'visera-images-v5'
const MAX_IMAGES = 120

const shellURLs = ['/', '/index.html', '/site.webmanifest', '/favicon.ico', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    await Promise.allSettled(shellURLs.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' })
      if (response.ok) await cache.put(url, response)
    }))
    const page = await cache.match('/')
    if (!page) return
    const html = await page.clone().text()
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], self.location.origin))
      .filter((url) => url.origin === self.location.origin && /^\/(?:assets|icons)\//.test(url.pathname))
    await Promise.allSettled(assets.map(async (url) => {
      const response = await fetch(url.href, { cache: 'reload' })
      if (response.ok) await cache.put(url.href, response)
    }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('visera-') && ![SHELL_CACHE, IMAGE_CACHE].includes(name)).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

function offlineAPIResponse() {
  return new Response(JSON.stringify({ error: { message: '当前处于离线状态，请恢复网络后重试。' } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function networkOnlyAPI(request) {
  try {
    return await fetch(request)
  } catch {
    return offlineAPIResponse()
  }
}

async function keepRecentImages(cache) {
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGES)).map((key) => cache.delete(key)))
}

async function cachedImage(request) {
  const cache = await caches.open(IMAGE_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok && response.headers.get('Content-Type')?.startsWith('image/')) {
      await cache.put(request, response.clone())
      await keepRecentImages(cache)
    }
    return response
  } catch {
    return new Response('', { status: 504, statusText: 'Image unavailable offline' })
  }
}

async function appShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put('/index.html', response.clone())
    return response
  } catch {
    return (await cache.match('/index.html')) || (await cache.match('/')) || new Response('离线且应用尚未完成安装。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
}

async function staticAsset(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone())
    return response
  })
  return cached || refresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/api/v1/assets/') && url.pathname.endsWith('/content') && !url.searchParams.has('download') && request.method === 'GET') {
    event.respondWith(cachedImage(request))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnlyAPI(request))
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(appShell(request))
    return
  }
  if (request.method === 'GET') event.respondWith(staticAsset(request))
})
