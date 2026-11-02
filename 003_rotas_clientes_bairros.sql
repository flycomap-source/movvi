-- =====================================================================
-- Movvi+ — rotas, adicionais por bairro e cadastro de clientes
-- =====================================================================
create extension if not exists unaccent with schema extensions;

alter table public.entregas add column if not exists rota_id uuid;
alter table public.entregas add column if not exists rota_ordem int;
alter table public.entregas add column if not exists adicionais int not null default 0;
create index if not exists entregas_rota_idx on public.entregas (rota_id);

-- Bairros que dão adicional ao entregador (a central edita no app)
insert into public.config (chave, valor) values ('bairros', '{"lista":[]}')
on conflict (chave) do nothing;

create or replace function public.norm_txt(t text) returns text
language sql immutable as $$
  select ' ' || regexp_replace(lower(extensions.unaccent(coalesce(t,''))), '[^a-z0-9]+', ' ', 'g') || ' '
$$;

-- Quantos adicionais o endereço/bairro dá (pega o bairro de nome mais longo que bater)
create or replace function public.adicionais_do_bairro(p_texto text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (b->>'qtd')::int
    from public.config c, jsonb_array_elements(c.valor->'lista') b
    where c.chave = 'bairros'
      and length(trim(b->>'nome')) > 0
      and public.norm_txt(p_texto) like '%' || public.norm_txt(b->>'nome') || '%'
    order by length(b->>'nome') desc limit 1), 0)
$$;

create or replace function public.calcular_ganho(p_taxa numeric, p_adicional boolean)
returns numeric language sql stable as $$
  with c as (select valor from public.config where chave = 'central')
  select case
    when p_adicional then coalesce((select (valor->>'valorAdicional')::numeric from c), 6)
    when p_taxa <= coalesce((select (valor->>'taxaPadrao')::numeric from c), 8)
      then coalesce((select (valor->>'ganhoMinimo')::numeric from c), 6)
    else greatest(
      coalesce((select (valor->>'ganhoMinimo')::numeric from c), 6),
      round(p_taxa * (1 - coalesce((select (valor->>'descontoAcima')::numeric from c), 0.25)), 2))
  end
$$;

create or replace function public.entregas_antes_salvar()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_central boolean := public.sou_central();
        v_ad numeric := coalesce((select (valor->>'valorAdicional')::numeric from public.config where chave='central'), 6);
begin
  if tg_op = 'INSERT' and coalesce(new.adicionais,0) = 0 and not new.adicional then
    new.adicionais := public.adicionais_do_bairro(coalesce(new.bairro,'') || ' ' || coalesce(new.endereco,''));
  end if;
  if not v_central then
    if tg_op = 'INSERT' then
      select coalesce(c.taxa, 8), coalesce(nullif(c.endereco,''), new.coleta_endereco)
        into new.taxa_cobrada, new.coleta_endereco
        from public.comercios c where c.id = new.comercio_id;
      new.adicional := false; new.acertado := false; new.acerto_id := null;
    else
      new.taxa_cobrada := old.taxa_cobrada; new.adicional := old.adicional;
      new.adicionais := old.adicionais;     new.comercio_id := old.comercio_id;
      new.acertado := old.acertado;         new.acerto_id := old.acerto_id;
      new.numero := old.numero;
    end if;
  end if;
  new.ganho_entregador := public.calcular_ganho(new.taxa_cobrada, new.adicional)
                          + case when new.adicional then 0 else coalesce(new.adicionais,0) * v_ad end;
  if new.status = 'entregue' and new.entregue_em is null then new.entregue_em := now(); end if;
  if new.status = 'aceita'   and new.aceito_em   is null then new.aceito_em   := now(); end if;
  if new.status = 'em_rota'  and new.coletado_em is null then new.coletado_em := now(); end if;
  if tg_op = 'INSERT' and new.criado_por is null then new.criado_por := auth.uid(); end if;
  return new;
end $$;

-- Clientes: um por telefone; qualquer usuário liberado pode salvar/atualizar
alter table public.clientes add column if not exists bairro text default '';
alter table public.clientes add column if not exists tel_digitos text
  generated always as (right(regexp_replace(coalesce(telefone,''), '\D', '', 'g'), 11)) stored;
create unique index if not exists clientes_tel_unico on public.clientes (tel_digitos) where tel_digitos <> '';

create or replace function public.salvar_cliente(p_nome text, p_telefone text, p_endereco text, p_bairro text, p_localizacao text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_dig text := right(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'), 11);
begin
  if public.meu_papel() is null or public.meu_papel() = 'pendente' then raise exception 'sem acesso'; end if;
  if length(v_dig) < 8 then return null; end if;
  insert into public.clientes (nome, telefone, endereco, bairro, localizacao)
  values (coalesce(p_nome,''), p_telefone, coalesce(p_endereco,''), coalesce(p_bairro,''), coalesce(p_localizacao,''))
  on conflict (tel_digitos) where tel_digitos <> '' do update set
    nome = coalesce(nullif(excluded.nome,''), clientes.nome),
    endereco = coalesce(nullif(excluded.endereco,''), clientes.endereco),
    bairro = coalesce(nullif(excluded.bairro,''), clientes.bairro),
    localizacao = coalesce(nullif(excluded.localizacao,''), clientes.localizacao)
  returning id into v_id;
  return v_id;
end $$;

-- Relatório do mês, calculado no banco (não tem limite de linhas)
create or replace function public.relatorio_periodo(p_de date, p_ate date)
returns jsonb language sql stable security definer set search_path = public as $$
  with e as (
    select e.*, c.nome as com_nome, t.nome as ent_nome
    from public.entregas e
    left join public.comercios c on c.id = e.comercio_id
    left join public.entregadores t on t.id = e.entregador_id
    where e.status = 'entregue' and e.data between p_de and p_ate and public.sou_central()
  )
  select jsonb_build_object(
    'entregas', (select count(*) from e),
    'adicionais', (select coalesce(sum(adicionais),0) + count(*) filter (where adicional) from e),
    'taxas', (select coalesce(sum(taxa_cobrada) filter (where not adicional),0) from e),
    'ganhos', (select coalesce(sum(ganho_entregador),0) from e),
    'dinheiro', (select coalesce(sum(valor_dinheiro) filter (where pagamento='dinheiro'),0) from e),
    'dinheiro_pendente', (select coalesce(sum(valor_dinheiro) filter (where pagamento='dinheiro' and not acertado),0) from e),
    'por_comercio', (select coalesce(jsonb_agg(x order by x->>'nome'),'[]') from (
        select jsonb_build_object('nome', coalesce(com_nome,'—'), 'qtd', count(*) filter (where not adicional),
               'taxas', coalesce(sum(taxa_cobrada) filter (where not adicional),0)) x
        from e group by com_nome) s),
    'por_entregador', (select coalesce(jsonb_agg(x order by x->>'nome'),'[]') from (
        select jsonb_build_object('nome', coalesce(ent_nome,'—'), 'qtd', count(*),
               'adicionais', coalesce(sum(adicionais),0) + count(*) filter (where adicional),
               'ganho', coalesce(sum(ganho_entregador),0),
               'dinheiro_pendente', coalesce(sum(valor_dinheiro) filter (where pagamento='dinheiro' and not acertado),0)) x
        from e group by ent_nome) s),
    'por_dia', (select coalesce(jsonb_agg(x order by x->>'data'),'[]') from (
        select jsonb_build_object('data', data, 'qtd', count(*), 'taxas', coalesce(sum(taxa_cobrada) filter (where not adicional),0),
               'ganhos', coalesce(sum(ganho_entregador),0)) x
        from e group by data) s)
  )
$$;
