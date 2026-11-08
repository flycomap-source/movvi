/* Movvi+ — service worker: permite instalar o app e mostra os avisos de entrega com o app fechado.
   Não guarda dados: tudo vem sempre do servidor (pedidos ao vivo). */
const VERSAO = "movvi-v2";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // só a página; o resto segue normal
  e.respondWith(fetch(req).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Movvi+</title>' +
    '<body style="margin:0;font:16px system-ui;background:#004AAD;color:#fff;display:grid;place-items:center;height:100vh;text-align:center;padding:24px">' +
    '<div><h2>Sem internet</h2><p>O Movvi+ precisa de internet. Confira a conexão e tente de novo.</p>' +
    '<button onclick="location.reload()" style="font:inherit;padding:12px 20px;border:0;border-radius:12px;background:#F28A1E;font-weight:700">Tentar de novo</button></div>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});

/* aviso de entrega nova (chega mesmo com o app fechado) */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { corpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Movvi+ Entregas", {
    body: d.corpo || "Abra o app para ver.",
    icon: "icone-192.png", badge: "icone-192.png",
    tag: d.tag || "movvi", renotify: true, requireInteraction: true,
    vibrate: [200, 80, 200, 80, 300],
    data: { url: d.url || "./" },
  }));
});
/* tocou no aviso: abre o app (ou traz para frente se já estiver aberto) */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
    for (const c of lista) { if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
