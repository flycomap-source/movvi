// Movvi+ — a central redefine a senha de um entregador ou comércio.
// Só quem tem papel "central" na tabela perfis pode usar.
const URL_SB = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
const adm = { apikey: SERVICO, Authorization: "Bearer " + SERVICO, "content-type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const u = await fetch(URL_SB + "/auth/v1/user", { headers: { Authorization: req.headers.get("Authorization") ?? "", apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" } });
    if (!u.ok) return resp({ erro: "sem_login" }, 401);
    const eu = await u.json();
    const p = await fetch(URL_SB + "/rest/v1/perfis?select=papel,ativo&id=eq." + encodeURIComponent(eu.id), { headers: adm });
    const perfil = (await p.json())?.[0];
    if (!perfil || perfil.papel !== "central" || perfil.ativo === false) return resp({ erro: "so_central", detalhe: "Só a central pode redefinir senhas." }, 403);

    const corpo = await req.json();
    // lista as contas do app (nome, usuário e tipo) para a central redefinir a senha de qualquer uma
    if (corpo?.listar) {
      const u = await fetch(URL_SB + "/auth/v1/admin/users?per_page=1000", { headers: adm });
      const us = ((await u.json())?.users ?? []) as Array<{ id: string; email?: string; user_metadata?: Record<string, string>; last_sign_in_at?: string; created_at?: string }>;
      const pf = await fetch(URL_SB + "/rest/v1/perfis?select=id,papel,nome,ativo", { headers: adm });
      const mapa = new Map(((await pf.json()) ?? []).map((x: { id: string }) => [x.id, x]));
      const contas = us.map((x) => { const p = (mapa.get(x.id) ?? {}) as { papel?: string; nome?: string; ativo?: boolean };
        return { uid: x.id, usuario: x.user_metadata?.usuario || String(x.email ?? "").split("@")[0], nome: p.nome || x.user_metadata?.nome || "", papel: p.papel ?? "pendente", ativo: p.ativo !== false, ultimoAcesso: x.last_sign_in_at ?? null, criado: x.created_at ?? null }; });
      return resp({ ok: true, contas });
    }
    const { uid, senha } = corpo;
    if (!uid || typeof senha !== "string" || senha.length < 6) return resp({ erro: "dados", detalhe: "Senha com pelo menos 6 caracteres." }, 400);
    if (uid === eu.id) return resp({ erro: "propria", detalhe: "Para a sua própria senha, use Meus dados." }, 400);
    const r = await fetch(URL_SB + "/auth/v1/admin/users/" + encodeURIComponent(uid), { method: "PUT", headers: adm, body: JSON.stringify({ password: senha }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return resp({ erro: "falha", detalhe: j?.msg ?? j?.message ?? String(r.status) }, 502); }
    console.log("senha redefinida", JSON.stringify({ por: eu.id, para: uid }));
    return resp({ ok: true });
  } catch (e) {
    return resp({ erro: "falha", detalhe: String(e) }, 500);
  }
});
