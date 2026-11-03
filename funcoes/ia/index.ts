// Movvi+ — IA do app (leitura de comanda pela foto, organização de rotas).
// Usa o segredo ANTHROPIC_API_KEY (Edge Functions > Secrets).
const MODELO = Deno.env.get("MODELO_IA") ?? "claude-haiku-5-5";
const MODELO_FORTE = Deno.env.get("MODELO_IA_FORTE") ?? "claude-sonnet-5-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });

function extrairJson(t: string): unknown {
  const limpo = t.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(limpo); } catch (_) { /* segue */ }
  const ini = limpo.search(/[\[{]/);
  if (ini < 0) return null;
  const fecha = limpo[ini] === "[" ? "]" : "}";
  const fim = limpo.lastIndexOf(fecha);
  try { return JSON.parse(limpo.slice(ini, fim + 1)); } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // só quem está logado no app
    const u = await fetch(Deno.env.get("SUPABASE_URL") + "/auth/v1/user", {
      headers: { Authorization: req.headers.get("Authorization") ?? "", apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!u.ok) return resp({ erro: "sem_login" }, 401);
    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return resp({ erro: "sem_chave" });

    const { entrada, imagens, json, nivel } = await req.json();
    const fotos = (Array.isArray(imagens) ? imagens : []).slice(0, 5).map((i: { b64: string; tipo?: string }) => ({
      type: "image", source: { type: "base64", media_type: i.tipo || "image/jpeg", data: i.b64 },
    }));
    const pedidoJson = json ? "\n\nResponda somente com o JSON pedido, sem texto antes ou depois." : "";
    let mensagens: { role: string; content: unknown }[];
    if (Array.isArray(entrada)) {
      mensagens = entrada.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));
      const ult = mensagens[mensagens.length - 1];
      ult.content = [...fotos, { type: "text", text: String(ult.content) + pedidoJson }];
    } else {
      mensagens = [{ role: "user", content: [...fotos, { type: "text", text: String(entrada ?? "") + pedidoJson }] }];
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: nivel === "complex" ? MODELO_FORTE : MODELO, max_tokens: 4096, messages: mensagens }),
    });
    const j = await r.json();
    if (r.status === 429) return resp({ erro: "rate_limited" }, 429);
    if (!r.ok) return resp({ erro: "ia", detalhe: j?.error?.message ?? String(r.status) }, 502);
    const texto = (j.content ?? []).filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("");
    console.log("ia", JSON.stringify({ fotos: fotos.length, json: !!json, parada: j.stop_reason, tamanho: texto.length }));
    if (!json) return resp({ texto });
    const valor = extrairJson(texto);
    if (valor === null) return resp({ erro: "sem_json", detalhe: "A IA não devolveu dados legíveis (" + j.stop_reason + ")." });
    return resp({ valor, texto });
  } catch (e) {
    return resp({ erro: "falha", detalhe: String(e) }, 500);
  }
});
