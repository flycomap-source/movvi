// Movvi+ — lê a foto de uma comanda e devolve os dados da entrega em JSON.
// Precisa do segredo ANTHROPIC_API_KEY configurado no Supabase (Edge Functions > Secrets).
const PROMPT = "A foto é de uma comanda/pedido de entrega de um comércio de Unaí-MG (Brasil): pode ser a comanda impressa da Drogaria Canaan ou um papel anotado à mão. Responda SOMENTE com um objeto JSON neste formato: {\"empresa\":\"\",\"pedidoComercio\":\"\",\"codigoCliente\":\"\",\"cliente\":\"\",\"clienteDoEndereco\":\"\",\"telefone\":\"\",\"telefoneCadastro\":\"\",\"endereco\":\"\",\"bairro\":\"\",\"pegarReceita\":false,\"produtosControlados\":[],\"trocoPara\":0,\"pagamento\":\"dinheiro|cartao|pago|convenio\",\"valorProdutos\":0,\"taxaEntrega\":0,\"valor\":0,\"previsaoPagamento\":\"\",\"observacoes\":\"\",\"confianca\":\"alta|media|baixa\"}. Há dois modelos comuns: (1) comanda impressa da Drogaria Canaan, com cliente identificado pelo telefone; (2) notinha da Farmácia Campos, preenchida à mão, com Sr.(a) = nome do cliente, End. = endereço, lista de produtos, TOTAL R$, e embaixo, junto da NOTA PROMISSÓRIA, a taxa de entrega abreviada \"TX\" e o valor total com a taxa. Farmacêuticos abreviam e escrevem rápido: leia com atenção nomes de ruas de Unaí (ex.: \"Princesa Isabel\"). Regras: empresa = nome do comércio (ex.: em \"Filial: 2 - DROGARIA CANAAN - LJ02 - UNAI\" responda \"Drogaria Canaan\"). pedidoComercio = número do pedido/comanda do comércio (campo \"Pedido No\"), como impresso. codigoCliente = código do cliente no sistema do comércio (o número impresso logo antes do nome do cliente). cliente = nome do cliente impresso no cabeçalho. clienteDoEndereco = nome de quem recebe, escrito junto do endereço de entrega nas observações (ex.: \"para Dona Natália\"); vazio se não houver. enderecoTrocado = true se for comanda impressa (ex.: Drogaria Canaan); senão false. endereco = endereço de entrega com rua, número, bairro e complemento (apto, bloco). NA COMANDA IMPRESSA (ex.: Drogaria Canaan): IGNORE COMPLETAMENTE o campo \"Endereco\" da parte de baixo e pegue o endereço das Observações, nesta ordem: 1º) verifique PRIMEIRO a \"Observação FISCAL\" (\"Observações FISCAL\"/\"Obs. Fiscal\"): se ela tiver um endereço, use esse endereço; 2º) se a Observação FISCAL estiver vazia ou não tiver endereço, use como endereço o que estiver escrito nas observações que ficam ACIMA dela na comanda (as outras Observações impressas em cima). Na notinha escrita à mão (ex.: Farmácia Campos), use o campo End. telefone = o telefone que está nas Observações junto com o endereço de entrega (na mesma observação de onde saiu o endereço: a FISCAL ou, se ela não tiver endereço, a de cima).NA COMANDA IMPRESSA: nunca use o \"Fone\"/\"Telefone\" do cabeçalho (perto do Cliente e CPF) nem números do campo Endereco de baixo; se não houver telefone nas Observações, deixe vazio. CEP (8 dígitos começando com 386) não é telefone. Só números com DDD. telefoneCadastro = o número do campo \"Fone\" do cabeçalho, só números. bairro = o bairro do endereço de entrega, só quando estiver indicado como bairro (ex.: \"Bairro Santa Clara\" ou o nome do bairro depois do número: em \"Rua Topógrafo 59 Alvorada\" o bairro é \"Alvorada\"; a palavra que vem logo depois do número da casa é sempre o bairro). Copie o número ou algarismo romano do bairro quando houver (ex.: \"Água Branca 1\", \"Água Branca II\"). Nome de rua ou avenida NÃO é bairro: \"Rua Santa Clara\" e \"Avenida Santa Clara\" são ruas. Vazio se não houver. trocoPara = a nota com que o cliente vai pagar em dinheiro quando pedir troco (ex.: \"troco p/ 100\" → 100); se a comanda mostrar só o valor do troco (ex.: total 56,00 e troco 44,00), some os dois; 0 se não houver troco. produtosControlados = lista com o nome de cada produto (como impresso depois do código, ex.: \"SERTRALINA 100MG 30CP GN EURO\") que tem logo embaixo \"Controlado : Sim\"; lista vazia se nenhum. Se houver algum, pegarReceita = true. pegarReceita = true se estiver escrito, impresso ou à mão, que é preciso pegar/recolher/trazer a receita (ex.: \"pegar receita\"); senão false. Se as observações disserem \"ENTREGAR NA/EM ...\" com outro endereço, ESSE é o endereço de entrega (e o telefone junto dele), mesmo que o campo Endereço tenha outro; o nome escrito junto (ex.: \"para Dona Natália\") é clienteDoEndereco. valorProdutos = total dos produtos (ex.: TOTAL R$ da notinha). taxaEntrega = taxa de entrega escrita (ex.: \"TX 5\"), 0 se não houver. valor = valor final que o cliente deve: \"Total a Receber\" da comanda, ou o total escrito com a taxa incluída; se só houver produtos e taxa, a soma dos dois. NUNCA use como valor a nota para troco nem o valor do troco: em \"valor da compra 157, troco para 200\" o valor é 157 e trocoPara é 200. Números com ponto decimal. pagamento = \"pago\" se houver a marca escrita à mão \"Pg\"/pago, se a forma impressa for \"PIX CONFERIDO\"/PIX, ou se estiver escrito \"já está pago\" — isso vale mesmo que a forma impressa seja CONVENIO ou haja \"Total a Receber\"; nesse caso valor = 0 e ignore os outros valores; \"convenio\" se for convênio / nota para o cliente assinar (palavras convênio, conv, assinar, promissória preenchida, vencimento ou previsão de pagamento preenchidos) ou se for notinha da Farmácia Campos sem outra forma de pagamento indicada; \"cartao\" se for cartão; senão \"dinheiro\". previsaoPagamento = o que estiver escrito em \"Previsão de pagamento\" ou \"Vencimento\" (vazio se nada). observacoes = horário de entrega (ex.: \"ENTREGAR 12:00\"), referências e recados úteis ao entregador, sem repetir o endereço e o telefone usados. NUNCA inclua CPF em nenhum campo. Não invente: deixe vazio o que não estiver na foto.";
const MODELO = Deno.env.get("MODELO_COMANDA") ?? "claude-haiku-5-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // só usuários logados no app podem usar
    const u = await fetch(Deno.env.get("SUPABASE_URL") + "/auth/v1/user", {
      headers: { Authorization: req.headers.get("Authorization") ?? "", apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!u.ok) return resp({ erro: "sem_login" }, 401);
    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return resp({ erro: "sem_chave" });
    const { imagem, tipo } = await req.json();
    if (!imagem) return resp({ erro: "sem_imagem" }, 400);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 1024,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: tipo || "image/jpeg", data: imagem } },
          { type: "text", text: PROMPT },
        ] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return resp({ erro: "ia", detalhe: j?.error?.message ?? r.status }, 502);
    const texto = (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = texto.match(/\{[\s\S]*\}/);
    return resp(m ? JSON.parse(m[0]) : { erro: "sem_json" });
  } catch (e) {
    return resp({ erro: "falha", detalhe: String(e) }, 500);
  }
});
