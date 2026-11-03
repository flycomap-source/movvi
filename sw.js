/* Movvi+ — service worker simples: permite instalar o app.
   Não guarda dados: tudo vem sempre do servidor (pedidos ao vivo). */
const VERSAO = "movvi-v1";
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
