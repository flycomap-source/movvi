/* Movvi+ — service worker: permite instalar o app e mostra os avisos de entrega com o app fechado.
   Não guarda dados: tudo vem sempre do servidor (pedidos ao vivo). */
const VERSAO = "movvi-v4";
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

/* aviso de entrega nova (chega mesmo com o app fechado).
   Todos os avisos ficam juntos numa notificação só: a nova substitui a anterior e lista os últimos pedidos. */
const GRUPO = "movvi-avisos";
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { corpo: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    const abertas = await self.registration.getNotifications({ tag: GRUPO }).catch(() => []);
    const ant = (abertas[0] && abertas[0].data) || {};
    const linha = [d.titulo, d.corpo].filter(Boolean).join(": ").replace(/^🛎️?\s*/, "");
    const linhas = [linha, ...(ant.linhas || [])].slice(0, 6);
    const n = (ant.n || 0) + 1;
    abertas.forEach((x) => x.close());
    await self.registration.showNotification(n > 1 ? "🛎️ " + n + " avisos novos · Movvi+" : (d.titulo || "Movvi+ Entregas"), {
      body: n > 1 ? linhas.join("\n") + (n > linhas.length ? "\n+" + (n - linhas.length) + " anteriores" : "") : (d.corpo || "Abra o app para ver."),
      icon: "icone-192.png", badge: "badge-96.png",
      tag: GRUPO, renotify: true, requireInteraction: true,
      vibrate: [200, 80, 200, 80, 300],
      data: { url: d.url || "./", linhas, n },
    });
  })());
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
