// Minimaler Service Worker: cached die App-Shell, Daten kommen immer live von Supabase.
const CACHE = "wop-shell-v22";
const SHELL = ["./", "index.html", "app.js", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Supabase & CDN nie cachen
  // Network-first: neueste Version laden, Cache nur als Offline-Fallback
  if (e.request.method !== "GET") return; // nur GETs cachen
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// ---- Push-Benachrichtigungen ----
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Procrastination Lists", {
    body: d.body || "",
    tag: d.tag || "wop",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: d,
    actions: d.actions || [],
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  // "✓ Erledigt"-Button: Aufgabe direkt abhaken, ohne die App zu öffnen
  if (e.action === "done" && e.notification.data && e.notification.data.completeUrl) {
    e.waitUntil(fetch(e.notification.data.completeUrl, { method: "POST" }).catch(() => {}));
    return;
  }
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow("./");
  }));
});
