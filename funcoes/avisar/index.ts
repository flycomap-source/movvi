// Movvi+ — avisos no celular (notificação com o app fechado).
// Chamada pelo banco quando entra um documento novo (oferta, entrega ou pedido de comércio).
// As chaves do aviso (VAPID) são criadas aqui mesmo na primeira vez e ficam guardadas na tabela push_config.
import webpush from "npm:web-push@3.6.7";

const URL_SB = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const adm = { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "content-type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
const rest = (caminho: string, init: RequestInit = {}) => fetch(URL_SB + "/rest/v1/" + caminho, { ...init, headers: { ...adm, ...(init.headers ?? {}) } });

let chaves: { publica: string; privada: string } | null = null;
async function pegarChaves() {
  if (chaves) return chaves;
  const r = await rest("push_config?select=publica,privada&id=eq.1");
  const linha = (await r.json())?.[0];
  if (linha?.publica) { chaves = linha; return chaves!; }
  const k = webpush.generateVAPIDKeys();
  await rest("push_config", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ id: 1, publica: k.publicKey, privada: k.privateKey }) });
  const r2 = await rest("push_config?select=publica,privada&id=eq.1");
  chaves = (await r2.json())[0];
  return chaves!;
}

const partes = (p: string) => String(p).split("/").filter(Boolean);
const texto = (d: Record<string, unknown>) => {
  const de = String(d.coletaEmpresa ?? d.transfDe ?? "").trim();
  const para = String(d.bairro ?? d.endereco ?? d.cliente ?? "").trim();
  return [de, para].filter(Boolean).join(" → ") || "Abra o app para ver.";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const k = await pegarChaves();
    if (req.method === "GET") return resp({ publica: k.publica });

    const { path } = await req.json();
    if (!path || typeof path !== "string") return resp({ erro: "sem_path" }, 400);
    // relê o documento no banco: só avisa sobre documento que existe e é recente (menos de 2 minutos)
    const r = await rest("docs?select=path,col,data,updated_by,updated_at&path=eq." + encodeURIComponent(path));
    const doc = (await r.json())?.[0];
    if (!doc) return resp({ ok: true, ignorado: "nao_existe" });
    if (Date.now() - new Date(doc.updated_at).getTime() > 120000) return resp({ ok: true, ignorado: "antigo" });
    const p = partes(doc.path), d = doc.data ?? {};

    let destinos: string[] = [], titulo = "", corpo = texto(d), tag = doc.path;
    if (p[0] === "entregas" && p[2] === "ofertas") { destinos = [p[1]]; titulo = "📦 Nova entrega disponível"; }
    else if (p[0] === "entregas" && p[2] === "pedidos") {
      if (doc.updated_by === p[1]) return resp({ ok: true, ignorado: "lancada_por_ele" });
      if (d.status && d.status !== "pendente") return resp({ ok: true, ignorado: "status" });
      destinos = [p[1]]; titulo = "📦 Nova entrega para você";
    } else if (p[0] === "abertos" || (p[0] === "lojas" && p[2] === "pedidos")) {
      if (d.status && d.status !== "solicitado") return resp({ ok: true, ignorado: "status" });
      const c = await rest("perfis?select=id&papel=eq.central");
      destinos = ((await c.json()) ?? []).map((x: { id: string }) => x.id);
      titulo = "🛎️ Novo pedido de comércio";
    } else if (p[0] === "recados") {
      // recado do comércio/central para o entregador que está com o pedido
      destinos = [String(d.para ?? "")].filter(Boolean);
      titulo = "📣 Recado de " + String(d.de ?? "comércio");
      corpo = String(d.texto ?? "") + (d.numero || d.cliente ? " · " + [d.numero ? "#" + d.numero : "", d.cliente ?? ""].filter(Boolean).join(" ") : "");
    } else return resp({ ok: true, ignorado: "colecao" });
    if (!destinos.length) return resp({ ok: true, ignorado: "sem_destino" });

    const ins = await rest("push_inscricoes?select=endpoint,p256dh,auth&user_id=in.(" + destinos.map(encodeURIComponent).join(",") + ")");
    const lista = (await ins.json()) ?? [];
    webpush.setVapidDetails("mailto:avisos@movvi.app", k.publica, k.privada);
    const msg = JSON.stringify({ titulo, corpo, tag, url: "./" });
    let enviados = 0;
    for (const s of lista) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { TTL: 600, urgency: "high" }); enviados++; }
      catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) await rest("push_inscricoes?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" });
        else console.log("falha aviso", st, String(e));
      }
    }
    return resp({ ok: true, enviados, inscritos: lista.length });
  } catch (e) {
    return resp({ erro: "falha", detalhe: String(e) }, 500);
  }
});
