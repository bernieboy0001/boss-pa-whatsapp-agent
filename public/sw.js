/*
 * Orbit PA service worker.
 *
 * Its only job is to keep desktop notifications alive and "persistent": a
 * notification raised through the registration is delivered by the browser even
 * when the tab is hidden or reloaded, and clicking it focuses (or re-opens) the
 * dashboard. No asset caching is done on purpose — the app is a live dashboard,
 * and a stale cached shell would be worse than a network fetch.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
