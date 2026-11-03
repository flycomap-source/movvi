/* =====================================================================
   Movvi+ — ponte entre o app original e o Supabase.
   O app original foi feito para rodar dentro do Claude e chama
   window.claude.use("db" | "user" | "assets" | "sample" | "room").
   Este arquivo oferece as mesmas funções, guardando tudo no Supabase.
   ===================================================================== */
(function () {
  "use strict";
  const SUPABASE_URL = "https://ilhizctomafdutxcdhxa.supabase.co";
  const SUPABASE_KEY = "sb_publishable_NPDPgeCujIx3r6i76DdxFA_vFKVVc3Y";
  const DOMINIO = "movvi.app";
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  window.movviSupabase = sb;

  let sessao = null, perfil = null;
  const novoId = () => {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const r = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(r, (x) => a[x % a.length]).join("");
  };
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const limpa = (o) => JSON.parse(JSON.stringify(o === undefined ? {} : o)); // remove undefined
  const erro = (e) => {
    const code = e && e.code === "42501" ? "permission-denied"
      : e && e.code === "P0002" ? "not-found"
      : (e && (e.code || e.status)) || "unavailable";
    const x = new Error((e && e.message) || String(e));
    x.code = code; return x;
  };
  const partes = (p) => String(p).split("/").filter(Boolean);

  /* ------------------------- Snapshots ------------------------- */
  function DocSnap(path, row) {
    const id = partes(path).slice(-1)[0];
    const dados = row ? row.data : undefined;
    return {
      id, exists: !!row, ref: docRef(path),
      data: () => (row ? clone(dados) : undefined),
      get: (k) => (row && dados ? clone(dados[k]) : undefined),
      metadata: { hasPendingWrites: false, fromCache: false },
    };
  }
  function QuerySnap(docs, mudancas) {
    return {
      docs, size: docs.length, empty: !docs.length,
      forEach: (fn) => docs.forEach(fn),
      docChanges: () => mudancas,
      metadata: { hasPendingWrites: false, fromCache: false },
    };
  }

  /* ------------------------- Ao vivo ------------------------- */
  // Um único canal para a tabela inteira; cada consulta ouve sua coleção.
  const ouvintes = new Map(); // col -> Set(fn)
  const ouvintesDoc = new Map(); // path -> Set(fn)
  let canal = null;
  function ligarCanal() {
    if (canal) return;
    canal = sb.channel("docs-ao-vivo")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const row = p.new && p.new.path ? p.new : p.old;
        if (!row) return;
        const col = row.col || partes(row.path).slice(0, -1).join("/");
        (ouvintes.get(col) || []).forEach((fn) => fn());
        (ouvintesDoc.get(row.path) || []).forEach((fn) => fn());
      })
      .subscribe((st) => {
        if (st === "CHANNEL_ERROR" || st === "TIMED_OUT") { canal = null; setTimeout(ligarCanal, 3000); }
        if (st === "SUBSCRIBED") { ouvintes.forEach((s) => s.forEach((fn) => fn())); ouvintesDoc.forEach((s) => s.forEach((fn) => fn())); }
      });
  }
  const somar = (mapa, k, fn) => { if (!mapa.has(k)) mapa.set(k, new Set()); mapa.get(k).add(fn); return () => { const s = mapa.get(k); if (s) { s.delete(fn); if (!s.size) mapa.delete(k); } }; };
  // quando o celular volta do segundo plano, recarrega tudo
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { ouvintes.forEach((s) => s.forEach((fn) => fn())); ouvintesDoc.forEach((s) => s.forEach((fn) => fn())); }
  });

  /* ------------------------- Consultas ------------------------- */
  function aplicarFiltros(q, filtros, ordem, limite) {
    for (const [f, op, v] of filtros) {
      const k = "data->>" + f;
      const val = (x) => (x === null || x === undefined ? null : typeof x === "object" ? JSON.stringify(x) : String(x));
      if (op === "==") q = v === null ? q.is(k, null) : q.eq(k, val(v));
      else if (op === "!=") q = q.neq(k, val(v));
      else if (op === "in") q = q.in(k, (v || []).map(val));
      else if (op === ">=") q = q.gte(k, val(v));
      else if (op === "<=") q = q.lte(k, val(v));
      else if (op === ">") q = q.gt(k, val(v));
      else if (op === "<") q = q.lt(k, val(v));
      else if (op === "array-contains") q = q.contains("data", { [f]: [v] });
    }
    for (const [f, dir] of ordem) q = q.order("data->>" + f, { ascending: dir !== "desc", nullsFirst: false });
    if (!ordem.length) q = q.order("path", { ascending: true });
    return q;
  }
  async function buscarColecao(col, filtros, ordem, limite) {
    const linhas = []; const passo = 1000; let ini = 0;
    while (true) {
      const ate = limite ? Math.min(limite, ini + passo) - 1 : ini + passo - 1;
      let q = sb.from("docs").select("path,data").eq("col", col);
      q = aplicarFiltros(q, filtros, ordem, limite).range(ini, ate);
      const { data, error } = await q;
      if (error) throw erro(error);
      linhas.push(...data);
      if (data.length < (ate - ini + 1) || (limite && linhas.length >= limite)) break;
      ini += passo;
    }
    return linhas;
  }

  function queryRef(col, filtros = [], ordem = [], limite = 0) {
    const self = {
      id: partes(col).slice(-1)[0], path: col,
      where: (f, op, v) => queryRef(col, [...filtros, [f, op, v]], ordem, limite),
      orderBy: (f, dir) => queryRef(col, filtros, [...ordem, [f, dir || "asc"]], limite),
      limit: (n) => queryRef(col, filtros, ordem, n),
      doc: (id) => docRef(col + "/" + (id || novoId())),
      add: async (obj) => { const r = docRef(col + "/" + novoId()); await r.set(obj); return r; },
      get: async () => {
        const linhas = await buscarColecao(col, filtros, ordem, limite);
        const docs = linhas.map((l) => DocSnap(l.path, l));
        return QuerySnap(docs, docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })));
      },
      onSnapshot: (cb, cbErro) => {
        let anterior = new Map(); let vivo = true; let timer = 0; let rodando = false; let denovo = false;
        const rodar = async () => {
          if (!vivo) return;
          if (rodando) { denovo = true; return; }
          rodando = true;
          try {
            const linhas = await buscarColecao(col, filtros, ordem, limite);
            if (!vivo) return;
            const atual = new Map(linhas.map((l) => [l.path, JSON.stringify(l.data)]));
            const docs = linhas.map((l) => DocSnap(l.path, l));
            const mud = [];
            docs.forEach((d, i) => {
              const p = col + "/" + d.id;
              if (!anterior.has(p)) mud.push({ type: "added", doc: d, oldIndex: -1, newIndex: i });
              else if (anterior.get(p) !== atual.get(p)) mud.push({ type: "modified", doc: d, oldIndex: i, newIndex: i });
            });
            anterior.forEach((json, p) => { if (!atual.has(p)) mud.push({ type: "removed", doc: DocSnap(p, { data: JSON.parse(json) }), oldIndex: -1, newIndex: -1 }); });
            const primeira = !rodar.ja; rodar.ja = true;
            anterior = atual;
            if (primeira || mud.length) cb(QuerySnap(docs, mud));
          } catch (e) { if (cbErro) cbErro(erro(e)); else console.warn("onSnapshot", col, e); }
          finally { rodando = false; if (denovo) { denovo = false; agendar(); } }
        };
        const agendar = () => { clearTimeout(timer); timer = setTimeout(rodar, 250); };
        ligarCanal();
        const tirar = somar(ouvintes, col, agendar);
        rodar();
        return () => { vivo = false; clearTimeout(timer); tirar(); };
      },
    };
    return self;
  }

  function docRef(path) {
    const ps = partes(path);
    const col = ps.slice(0, -1).join("/"), id = ps.slice(-1)[0];
    const ref = {
      id, path,
      collection: (nome) => queryRef(path + "/" + nome),
      get: async () => {
        const { data, error } = await sb.from("docs").select("path,data").eq("path", path).maybeSingle();
        if (error) throw erro(error);
        return DocSnap(path, data);
      },
      set: async (obj) => {
        const { error } = await sb.from("docs").upsert({ path, col, id, data: limpa(obj) });
        if (error) throw erro(error);
      },
      update: async (obj) => {
        const { error } = await sb.rpc("doc_update", { p_path: path, p_patch: limpa(obj) });
        if (error) throw erro(error);
      },
      delete: async () => {
        const { error } = await sb.from("docs").delete().eq("path", path);
        if (error) throw erro(error);
      },
      // trava curta "quem pega primeiro" (código de cliente, aceite de oferta)
      acquire: async (opts) => {
        opts = opts || {};
        const { data, error } = await sb.rpc("doc_acquire", { p_path: path, p_holder: String(opts.holder || "anon"), p_ttl_ms: Number(opts.ttlMs) || 30000 });
        if (error) throw erro(error);
        if (data && data.acquired && opts.data) { try { await ref.update(opts.data); } catch (_) { await ref.set(opts.data); } }
        return data || { acquired: false };
      },
      onSnapshot: (cb, cbErro) => {
        let vivo = true; let ultimo = null; let timer = 0;
        const rodar = async () => {
          if (!vivo) return;
          try {
            const { data, error } = await sb.from("docs").select("path,data").eq("path", path).maybeSingle();
            if (error) throw error;
            const j = JSON.stringify(data ? data.data : null);
            if (!vivo || j === ultimo) return;
            ultimo = j; cb(DocSnap(path, data));
          } catch (e) { if (cbErro) cbErro(erro(e)); }
        };
        ligarCanal();
        const tirar = somar(ouvintesDoc, path, () => { clearTimeout(timer); timer = setTimeout(rodar, 200); });
        rodar();
        return () => { vivo = false; clearTimeout(timer); tirar(); };
      },
    };
    return ref;
  }
  const db = Object.freeze({
    collection: (p) => queryRef(partes(p).join("/")),
    doc: (p) => docRef(partes(p).join("/")),
  });

  /* ------------------------- Usuário ------------------------- */
  const user = Object.freeze({
    id: async () => (sessao ? sessao.user.id : null),
    isOwner: async () => !!(perfil && perfil.papel === "central"),
    canEdit: async () => !!(perfil && perfil.papel === "central"),
    can: async () => true,
    me: async () => ({ id: sessao ? sessao.user.id : null }),
    profiles: async (ids) => Object.fromEntries((ids || []).map((i) => [i, { id: i, name: "" }])),
  });

  /* ------------------------- Fotos ------------------------- */
  const urlFoto = (id) => SUPABASE_URL + "/storage/v1/object/public/fotos/" + encodeURIComponent(id);
  window.movviFoto = urlFoto;
  const assets = Object.freeze({
    upload: async (blob) => {
      const tipo = blob.type || "image/jpeg";
      const ext = tipo.includes("png") ? ".png" : tipo.includes("webp") ? ".webp" : tipo.includes("pdf") ? ".pdf" : ".jpg";
      const id = novoId() + ext;
      const { error } = await sb.storage.from("fotos").upload(id, blob, { contentType: tipo, upsert: false });
      if (error) throw erro(error);
      return { id, url: urlFoto(id), sizeBytes: blob.size, contentType: tipo };
    },
    list: async () => {
      const lista = []; let offset = 0;
      while (true) {
        const { data, error } = await sb.storage.from("fotos").list("", { limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } });
        if (error) throw erro(error);
        lista.push(...data); if (data.length < 1000) break; offset += 1000;
      }
      const assets = lista.filter((a) => a.id).map((a) => ({
        id: a.name, url: urlFoto(a.name), createdAt: a.created_at,
        contentType: (a.metadata && a.metadata.mimetype) || "image/jpeg", sizeBytes: (a.metadata && a.metadata.size) || 0,
      }));
      return { assets, usage: { bytes: assets.reduce((s, a) => s + a.sizeBytes, 0), count: assets.length } };
    },
    delete: async (id) => { const { error } = await sb.storage.from("fotos").remove([id]); if (error) throw erro(error); },
  });

  /* ------------------------- IA (leitura de comanda, rotas) ------------------------- */
  const paraBase64 = (blob) => new Promise((ok, falha) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1]); fr.onerror = falha; fr.readAsDataURL(blob); });
  async function perguntar(input, opts, comoJson) {
    opts = opts || {};
    let imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
    const imagens = [];
    for (const b of imgs) if (b) imagens.push({ b64: await paraBase64(b), tipo: b.type || "image/jpeg" });
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(SUPABASE_URL + "/functions/v1/ia", {
      method: "POST", signal: opts.signal,
      headers: { "content-type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + (session ? session.access_token : SUPABASE_KEY) },
      body: JSON.stringify({ entrada: input, imagens, json: !!comoJson, nivel: opts.modelTier || "default" }),
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.status === 429 || (j && j.erro === "rate_limited")) { const e = new Error("Muitas leituras seguidas. Espere um pouco."); e.code = "rate_limited"; throw e; }
    if (!r.ok || !j || j.erro) { const e = new Error((j && (j.detalhe || j.erro)) || "Falha na IA"); e.code = (j && j.erro) || "error"; throw e; }
    return j;
  }
  const sample = async (input, opts) => { const j = await perguntar(input, opts, false); if (opts && opts.onText) try { opts.onText({ text: j.texto, delta: j.texto }); } catch (_) {} return { text: j.texto, truncated: false }; };
  sample.json = async (input, opts) => (await perguntar(input, opts, true)).valor;
  sample.limits = async () => ({ images: { mediaTypes: ["image/jpeg", "image/png", "image/webp"], maxCount: 5, maxBytes: 5 * 1024 * 1024 } });

  /* ------------------------- Quem está online ------------------------- */
  let salaCanal = null, minhaPresenca = {}, ouvintesPeers = new Set();
  function sala() {
    if (salaCanal) return salaCanal;
    salaCanal = sb.channel("movvi-online", { config: { presence: { key: sessao.user.id } } });
    const avisar = () => {
      const est = salaCanal.presenceState();
      const peers = Object.entries(est).map(([by, arr]) => ({ by, isMe: by === sessao.user.id, state: (arr && arr[0]) || {} }));
      ouvintesPeers.forEach((fn) => { try { fn({ peers }); } catch (_) {} });
    };
    salaCanal.on("presence", { event: "sync" }, avisar).subscribe((st) => { if (st === "SUBSCRIBED") salaCanal.track(minhaPresenca); });
    return salaCanal;
  }
  const room = Object.freeze({
    presence: async (estado) => { minhaPresenca = { ...(estado || {}) }; const c = sala(); try { await c.track(minhaPresenca); } catch (_) {} },
    onPeers: (fn) => { ouvintesPeers.add(fn); sala(); return () => ouvintesPeers.delete(fn); },
    emit: async () => {}, on: () => () => {}, leave: async () => {}, join: () => room,
  });

  /* ------------------------- Entrada (login) ------------------------- */
  let liberar; const pronto = new Promise((r) => (liberar = r));
  const css = `
  #movviLogin{position:fixed;inset:0;z-index:9999;background:#004AAD;display:flex;align-items:center;justify-content:center;
    padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));font:15px/1.45 "Figtree",system-ui,sans-serif}
  #movviLogin form{background:#fff;color:#14152E;border-radius:18px;padding:22px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.25)}
  #movviLogin .lg{font:900 28px/1 "Nunito",system-ui,sans-serif;color:#004AAD;text-align:center}
  #movviLogin .lg i{font-style:normal;color:#F28A1E}
  #movviLogin label{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5F6285;display:flex;flex-direction:column;gap:5px}
  #movviLogin input{font:inherit;border:1.5px solid #DADCEC;border-radius:12px;padding:11px 12px;color:#14152E;background:#fff;text-transform:none;letter-spacing:0}
  #movviLogin input:focus{outline:none;border-color:#004AAD}
  #movviLogin .bt{border:0;border-radius:12px;padding:13px;font:800 16px "Nunito",system-ui,sans-serif;background:#F28A1E;color:#1B1100;cursor:pointer}
  #movviLogin .bt:disabled{opacity:.6}
  #movviLogin .tr{border:0;background:none;color:#004AAD;font-weight:700;padding:6px;cursor:pointer}
  #movviLogin .er{background:#FDE3E1;color:#B42318;border-radius:10px;padding:10px 12px;font-size:14px}
  #movviLogin .mt{color:#5F6285;font-size:13px;text-align:center;margin:0}`;
  function telaLogin(modo, msg) {
    let el = document.getElementById("movviLogin");
    if (!el) { const st = document.createElement("style"); st.textContent = css; document.head.append(st); el = document.createElement("div"); el.id = "movviLogin"; document.body.append(el); }
    const cad = modo === "cadastrar";
    el.innerHTML = `<form autocomplete="on">
      <div class="lg">MOVVi<i>+</i></div>
      <p class="mt">${cad ? "Crie seu acesso. Depois a central libera você." : "Entre com seu usuário e senha."}</p>
      ${cad ? '<label>Seu nome<input id="mlNome" autocomplete="name" required></label>' : ""}
      <label>Usuário<input id="mlUser" autocomplete="username" autocapitalize="none" required></label>
      <label>Senha<input id="mlSenha" type="password" autocomplete="${cad ? "new-password" : "current-password"}" required></label>
      <div class="er" id="mlErro" hidden></div>
      <button class="bt" type="submit">${cad ? "Criar acesso" : "Entrar"}</button>
      <button class="tr" type="button" id="mlTroca">${cad ? "Já tenho acesso — entrar" : "Primeira vez? Criar acesso"}</button>
      ${cad ? "" : '<p class="mt">Esqueceu a senha? Peça à central para redefinir.</p>'}
    </form>`;
    const f = el.querySelector("form"), er = el.querySelector("#mlErro");
    if (msg) { er.hidden = false; er.textContent = msg; }
    el.querySelector("#mlTroca").onclick = () => telaLogin(cad ? "entrar" : "cadastrar");
    f.onsubmit = async (ev) => {
      ev.preventDefault(); er.hidden = true;
      const user = el.querySelector("#mlUser").value.trim(), senha = el.querySelector("#mlSenha").value;
      if (senha.length < 6) { er.hidden = false; er.textContent = "A senha precisa ter pelo menos 6 caracteres."; return; }
      const email = user.toLowerCase().replace(/[^a-z0-9._-]/g, "") + "@" + DOMINIO;
      const bt = f.querySelector(".bt"); bt.disabled = true; bt.textContent = "Aguarde…";
      const r = cad
        ? await sb.auth.signUp({ email, password: senha, options: { data: { nome: el.querySelector("#mlNome").value.trim(), usuario: user } } })
        : await sb.auth.signInWithPassword({ email, password: senha });
      if (r.error) {
        bt.disabled = false; bt.textContent = cad ? "Criar acesso" : "Entrar"; er.hidden = false;
        const t = r.error.message || "";
        er.textContent = /Invalid login/i.test(t) ? "Usuário ou senha incorretos." : /already registered/i.test(t) ? "Esse usuário já existe. Escolha outro ou entre." : "Não foi possível: " + t;
        return;
      }
      await entrar();
    };
  }
  async function entrar() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { telaLogin("entrar"); return; }
    sessao = session;
    const meta = session.user.user_metadata || {};
    window.movviUsuario = meta.usuario || String(session.user.email || "").replace("@" + DOMINIO, "");
    const { data: p }= await sb.from("perfis").select("papel,nome,ativo").eq("id", session.user.id).maybeSingle();
    perfil = p || { papel: "pendente" };
    const el = document.getElementById("movviLogin"); if (el) el.remove();
    liberar();
  }
  sb.auth.onAuthStateChange((ev, s) => { if (s) sessao = s; if (ev === "SIGNED_OUT") location.reload(); });
  window.movviSair = async () => { try { sessionStorage.clear(); } catch (_) {} await sb.auth.signOut(); location.reload(); };
  window.movviUmaEntrada = true; // a conta (usuário e senha) é a única entrada; a trava antiga do app fica desligada
  window.movviTrocarSenha = async (nova) => {
    const { error } = await sb.auth.updateUser({ password: nova });
    if (error) throw new Error(/different from the old/i.test(error.message) ? "a nova senha é igual à atual" : error.message);
  };
  window.movviRedefinirSenha = async (uid, nova) => {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(SUPABASE_URL + "/functions/v1/senha", {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + (session ? session.access_token : "") },
      body: JSON.stringify({ uid, senha: nova }),
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || j.erro) throw new Error((j && (j.detalhe || j.erro)) || "erro " + r.status);
  };

  const servicos = { db, user, assets, sample, room };
  window.claude = Object.freeze({
    use: async (nome) => { await pronto; return servicos[nome] || null; },
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", entrar); else entrar();
})();
