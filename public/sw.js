/*
 * Orbit PA service worker.
 *
 * Two jobs:
 *   1. Keep desktop notifications "persistent" — a notification raised through
 *      the registration is delivered by the browser even when the tab is hidden
 *      or reloaded, and clicking it focuses (or re-opens) the dashboard.
 *   2. Make the app installable + give it an offline shell. Browsers only offer
 *      "Add to Home Screen" / install when a service worker handles fetch, so we
 *      cache the app shell network-first (always fresh online) and fall back to
 *      the cache when the network is unavailable.
 *
 * API and auth requests are never cached.
 */

const CACHE = "orbit-shell-v1";
const SHELL = [
  "/",
  "/style.css",
  "/dashboard.js",
  "/manifest.webmanifest",
  "/davric-logo.png",
  "/notify-chime.wav",
  "/icons/favicon-48.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname === "/login" || url.pathname.startsWith("/auth") || url.pathname === "/logout") {
    return false;
  }
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isCacheable(url)) return;

  // Network-first: fresh when online, cached shell when offline.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        if (res && res.ok && res.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(request, res.clone()).catch(() => undefined);
        }
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = (await caches.match("/")) || (await caches.match("/index.html"));
          if (shell) return shell;
        }
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          try {
            if (target && typeof client.navigate === "function") await client.navigate(target);
          } catch {
            /* navigation is best-effort */
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })(),
  );
});

self.addEventListener("notificationclose", () => {
  /* no-op: kept so the handler exists for browsers that probe it */
});
