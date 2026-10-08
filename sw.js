const CACHE_PREFIX = "poolak-shell-";
const CACHE_NAME = "poolak-shell-v10";
const APP_SHELL_KEY = "/__poolak_app_shell__";
const CORE_ASSETS = [
  "/manifest.webmanifest",
  "/favicon.svg",
  "/apple-touch-icon.svg",
  "/apple-touch-icon-v2.png",
  "/icon-192-v2.png",
  "/icon-512-v2.png",
];
const NETWORK_TIMEOUT_MS = 8000;

function isSameOrigin(url) {
  return new URL(url, self.location.origin).origin === self.location.origin;
}

function isCacheable(response) {
  return response.ok && response.type !== "opaque" && isSameOrigin(response.url);
}

function extractAssets(html) {
  return [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => `${url.pathname}${url.search}`);
}

async function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheAsset(url, cache, visited) {
  if (visited.has(url)) return;
  visited.add(url);
  const request = new Request(url, { cache: "reload", credentials: "include" });
  const response = await fetchWithTimeout(request);
  if (!isCacheable(response)) throw new Error(`Could not cache ${url}`);
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/html")) throw new Error(`Unexpected page for ${url}`);
  const source = /(?:javascript|text\/css)/i.test(type) ? await response.clone().text() : "";
  await cache.put(url, response);
  // CSS fonts and nested JS modules are needed even if the first page load was
  // not yet controlled by this worker.
  const references = type.includes("text/css")
    ? [...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)].map((match) => match[1] || match[2])
    : [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  const dependencies = references
    .filter((ref) => ref.startsWith(".") || ref.startsWith("/"))
    .map((ref) => new URL(ref, new URL(url, self.location.origin)))
    .filter((dependency) => dependency.origin === self.location.origin)
    .map((dependency) => dependency.href);
  await Promise.all(dependencies.map((dependency) => cacheAsset(dependency, cache, visited)));
}

async function cacheShellResponse(response) {
  if (!isCacheable(response) || !response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("App shell response is unavailable");
  }

  const cache = await caches.open(CACHE_NAME);
  const html = await response.clone().text();
  if (!html.includes('data-poolak-app="true"')) throw new Error("Not the Poolak app shell");

  const assets = [...new Set([...CORE_ASSETS, ...extractAssets(html)])].filter((url) => url !== "/");
  const visited = new Set();
  const results = await Promise.allSettled(assets.map((url) => cacheAsset(url, cache, visited)));
  const missingCriticalAsset = results.some((result, index) => {
    if (result.status === "fulfilled") return false;
    return /(?:\/_next\/static\/|\.(?:js|css)(?:\?|$))/i.test(assets[index]);
  });
  if (missingCriticalAsset) throw new Error("Some required app files could not be cached");

  // Commit the entry page only after its required files are available.
  await cache.put("/", response.clone());
  await cache.put(APP_SHELL_KEY, response.clone());

  return { assetCount: results.filter((result) => result.status === "fulfilled").length + 1 };
}

async function warmAppShell() {
  const response = await fetchWithTimeout(new Request("/", {
    cache: "reload",
    credentials: "include",
  }), 15000);
  return cacheShellResponse(response);
}

function offlineFallback() {
  return new Response(`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#075f5a"><title>پولک — آفلاین</title><style>html{font-family:system-ui,sans-serif;background:#f5f7fb;color:#102a2a}body{min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{max-width:420px;background:#fff;border:1px solid #dce7e6;border-radius:28px;padding:28px;text-align:center;box-shadow:0 18px 50px #075f5a18}.icon{width:64px;height:64px;margin:auto;display:grid;place-items:center;border-radius:20px;background:#075f5a;color:#fff;font-size:32px}h1{font-size:22px;margin:20px 0 8px}p{line-height:2;color:#58706e;margin:0}button{margin-top:20px;border:0;border-radius:14px;background:#075f5a;color:#fff;padding:12px 20px;font:inherit;font-weight:800}</style></head><body><main class="card"><div class="icon">پ</div><h1>پولک هنوز برای آفلاین آماده نشده</h1><p>یک‌بار با اینترنت برنامه را باز نگه دار تا پیام «آفلاین آماده» نمایش داده شود، سپس دوباره امتحان کن.</p><button onclick="location.reload()">تلاش دوباره</button></main></body></html>`, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await warmAppShell();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "POOLAK_OFFLINE_STATUS") {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.match(APP_SHELL_KEY))
      .then((shell) => event.ports[0]?.postMessage({ ok: Boolean(shell) })));
    return;
  }
  if (event.data?.type === "POOLAK_SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type !== "POOLAK_PREPARE_OFFLINE") return;

  event.waitUntil(warmAppShell()
    .then((result) => event.ports[0]?.postMessage({ ok: true, ...result }))
    .catch((error) => event.ports[0]?.postMessage({ ok: false, error: error?.message || "Offline setup failed" })));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !isSameOrigin(request.url) || request.headers.has("range")) return;

  if (request.mode === "navigate" && new URL(request.url).pathname === "/") {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request);
        if (response.status >= 500) throw new Error("Server unavailable");
        if (isCacheable(response)) event.waitUntil(cacheShellResponse(response.clone()).catch(() => undefined));
        return response;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(APP_SHELL_KEY);
        return cached || offlineFallback();
      }
    })());
    return;
  }

  const destination = request.destination;
  const staticAsset = ["script", "style", "font", "image", "manifest"].includes(destination)
    || new URL(request.url).pathname.startsWith("/_next/static/");
  if (!staticAsset) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const update = fetch(request).then(async (response) => {
      if (isCacheable(response) && !response.headers.get("content-type")?.includes("text/html")) await (await caches.open(CACHE_NAME)).put(request, response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(update.catch(() => undefined));
      return cached;
    }
    return update;
  })());
});
