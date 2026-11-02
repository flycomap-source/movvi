-- =====================================================================
-- Movvi+ Entregas — estrutura do banco (Supabase / Postgres)
-- Perfis: central (vê tudo), comercio (só as entregas dele),
--         entregador (só as dele + as ofertas abertas)
-- =====================================================================

-- ---------- Tabelas de cadastro ----------
create table if not exists public.comercios (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  endereco    text default '',
  telefone    text default '',
  taxa        numeric(10,2) not null default 8,   -- taxa padrão cobrada por entrega
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

create table if not exists public.entregadores (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  telefone    text default '',
  ativo       boolean not null default true,
  disponivel  boolean not null default true,
  criado_em   timestamptz not null default now()
);

-- Cada login (auth.users) tem um perfil que diz quem ele é
create table if not exists public.perfis (
  id             uuid primary key references auth.users(id) on delete cascade,
  papel          text not null check (papel in ('central','comercio','entregador','pendente')) default 'pendente',
  nome           text default '',
  telefone       text default '',
  comercio_id    uuid references public.comercios(id) on delete set null,
  entregador_id  uuid references public.entregadores(id) on delete set null,
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now()
);

create table if not exists public.clientes (
  id           uuid primary key default gen_random_uuid(),
  nome         text default '',
  telefone     text default '',
  endereco     text default '',
  localizacao  text default '',
  codigo       text default '',
  criado_em    timestamptz not null default now()
);
create index if not exists clientes_telefone_idx on public.clientes (telefone);

-- Configurações gerais (ex.: valor do adicional, nome da central)
create table if not exists public.config (
  chave  text primary key,
  valor  jsonb not null default '{}'::jsonb
);
insert into public.config (chave, valor) values
  ('central', '{"nome":"Movvi+","valorAdicional":6,"ganhoMinimo":6,"taxaPadrao":8,"descontoAcima":0.25}')
on conflict (chave) do nothing;

-- ---------- Acertos de dinheiro (antes das entregas, por causa da FK) ----------
create table if not exists public.acertos (
  id             uuid primary key default gen_random_uuid(),
  entregador_id  uuid not null references public.entregadores(id),
  de             date not null,
  ate            date not null,
  dinheiro       numeric(10,2) not null default 0,
  qtd_entregas   int not null default 0,
  criado_em      timestamptz not null default now(),
  criado_por     uuid references auth.users(id)
);

-- ---------- Entregas ----------
create table if not exists public.entregas (
  id               uuid primary key default gen_random_uuid(),
  numero           bigint generated always as identity,
  data             date not null default (now() at time zone 'America/Sao_Paulo')::date,
  comercio_id      uuid references public.comercios(id),
  coleta_endereco  text default '',
  pedido_comercio  text default '',          -- nº do pedido no sistema do comércio
  cliente_id       uuid references public.clientes(id) on delete set null,
  cliente_nome     text default '',
  cliente_telefone text default '',
  endereco         text default '',
  localizacao      text default '',
  bairro           text default '',
  obs              text default '',
  entregador_id    uuid references public.entregadores(id),   -- vazio = oferta aberta
  status           text not null default 'solicitado'
                   check (status in ('solicitado','aceita','em_rota','entregue','cancelado')),
  pagamento        text not null default 'pago' check (pagamento in ('pago','dinheiro','cartao','pix')),
  valor_dinheiro   numeric(10,2) not null default 0,   -- só o que o entregador recebe em espécie
  troco_para       numeric(10,2) not null default 0,
  taxa_cobrada     numeric(10,2) not null default 8,   -- quanto o comércio paga por esta entrega
  adicional        boolean not null default false,     -- entrega a mais paga pela central (R$ 6)
  ganho_entregador numeric(10,2),                      -- calculado automaticamente
  foto_path        text,                               -- comprovante no Storage
  foto_em          timestamptz,
  aceito_em        timestamptz,
  coletado_em      timestamptz,
  entregue_em      timestamptz,
  acertado         boolean not null default false,     -- dinheiro já acertado com a central
  acerto_id        uuid references public.acertos(id) on delete set null,
  criado_em        timestamptz not null default now(),
  criado_por       uuid references auth.users(id)
);
create index if not exists entregas_data_idx       on public.entregas (data);
create index if not exists entregas_entregador_idx on public.entregas (entregador_id, data);
create index if not exists entregas_comercio_idx   on public.entregas (comercio_id, data);
create index if not exists entregas_status_idx     on public.entregas (status);

-- ---------- Fechamento semanal (semana termina no domingo) ----------
create table if not exists public.fechamentos (
  id               uuid primary key default gen_random_uuid(),
  semana_inicio    date not null,   -- segunda-feira
  semana_fim       date not null,   -- domingo
  entregador_id    uuid references public.entregadores(id),
  comercio_id      uuid references public.comercios(id),
  qtd_entregas     int not null default 0,
  qtd_adicionais   int not null default 0,
  valor            numeric(10,2) not null default 0,  -- a pagar ao entregador / a receber do comércio
  pago             boolean not null default false,
  pago_em          timestamptz,
  criado_em        timestamptz not null default now(),
  check ((entregador_id is null) <> (comercio_id is null))
);

-- =====================================================================
-- Regra de ganho do entregador
--   taxa até R$ 8  -> R$ 6
--   taxa acima de 8 -> taxa menos 25%, nunca abaixo de R$ 6
--   adicional       -> R$ 6 (valor configurável)
-- =====================================================================
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
returns trigger language plpgsql as $$
begin
  new.ganho_entregador := public.calcular_ganho(new.taxa_cobrada, new.adicional);
  if new.status = 'entregue' and new.entregue_em is null then new.entregue_em := now(); end if;
  if new.status = 'aceita'   and new.aceito_em   is null then new.aceito_em   := now(); end if;
  if new.status = 'em_rota'  and new.coletado_em is null then new.coletado_em := now(); end if;
  if tg_op = 'INSERT' and new.criado_por is null then new.criado_por := auth.uid(); end if;
  return new;
end $$;

drop trigger if exists entregas_antes_salvar on public.entregas;
create trigger entregas_antes_salvar before insert or update on public.entregas
  for each row execute function public.entregas_antes_salvar();

-- Cria o perfil automaticamente quando alguém se cadastra
create or replace function public.novo_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, telefone)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome',''), coalesce(new.raw_user_meta_data->>'telefone',''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- =====================================================================
-- Funções de apoio às permissões
-- =====================================================================
create or replace function public.meu_papel() returns text
language sql stable security definer set search_path = public as $$
  select papel from public.perfis where id = auth.uid() and ativo
$$;
create or replace function public.meu_entregador() returns uuid
language sql stable security definer set search_path = public as $$
  select entregador_id from public.perfis where id = auth.uid() and ativo and papel = 'entregador'
$$;
create or replace function public.meu_comercio() returns uuid
language sql stable security definer set search_path = public as $$
  select comercio_id from public.perfis where id = auth.uid() and ativo and papel = 'comercio'
$$;
create or replace function public.sou_central() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select papel = 'central' from public.perfis where id = auth.uid() and ativo), false)
$$;

-- =====================================================================
-- Segurança por linha (cada um vê só o que é seu)
-- =====================================================================
alter table public.comercios    enable row level security;
alter table public.entregadores enable row level security;
alter table public.perfis       enable row level security;
alter table public.clientes     enable row level security;
alter table public.config       enable row level security;
alter table public.entregas     enable row level security;
alter table public.acertos      enable row level security;
alter table public.fechamentos  enable row level security;

-- Central: acesso total a tudo
do $$
declare t text;
begin
  foreach t in array array['comercios','entregadores','perfis','clientes','config','entregas','acertos','fechamentos'] loop
    execute format('drop policy if exists central_tudo on public.%I', t);
    execute format('create policy central_tudo on public.%I for all to authenticated using (public.sou_central()) with check (public.sou_central())', t);
  end loop;
end $$;

-- Perfis: cada um lê o próprio
drop policy if exists perfil_proprio on public.perfis;
create policy perfil_proprio on public.perfis for select to authenticated using (id = auth.uid());

-- Config e lista de comércios: qualquer usuário ativo pode ler
drop policy if exists config_ler on public.config;
create policy config_ler on public.config for select to authenticated using (public.meu_papel() is not null);
drop policy if exists comercios_ler on public.comercios;
create policy comercios_ler on public.comercios for select to authenticated
  using (public.meu_papel() in ('entregador','comercio'));

-- Entregador: vê e altera o próprio cadastro (disponível/indisponível)
drop policy if exists entregador_proprio on public.entregadores;
create policy entregador_proprio on public.entregadores for select to authenticated using (id = public.meu_entregador());
drop policy if exists entregador_disponivel on public.entregadores;
create policy entregador_disponivel on public.entregadores for update to authenticated
  using (id = public.meu_entregador()) with check (id = public.meu_entregador());

-- Entregas — entregador: as dele + ofertas abertas
drop policy if exists entregas_entregador_ver on public.entregas;
create policy entregas_entregador_ver on public.entregas for select to authenticated
  using (entregador_id = public.meu_entregador()
         or (entregador_id is null and status = 'solicitado' and public.meu_entregador() is not null));
drop policy if exists entregas_entregador_mudar on public.entregas;
create policy entregas_entregador_mudar on public.entregas for update to authenticated
  using (entregador_id = public.meu_entregador()
         or (entregador_id is null and status = 'solicitado' and public.meu_entregador() is not null))
  with check (entregador_id = public.meu_entregador());
drop policy if exists entregas_entregador_lancar on public.entregas;
create policy entregas_entregador_lancar on public.entregas for insert to authenticated
  with check (entregador_id = public.meu_entregador());

-- Entregas — comércio: só as dele
drop policy if exists entregas_comercio_ver on public.entregas;
create policy entregas_comercio_ver on public.entregas for select to authenticated
  using (comercio_id = public.meu_comercio());
drop policy if exists entregas_comercio_lancar on public.entregas;
create policy entregas_comercio_lancar on public.entregas for insert to authenticated
  with check (comercio_id = public.meu_comercio() and entregador_id is null and status = 'solicitado');

-- Clientes: entregador e comércio podem ler e cadastrar
drop policy if exists clientes_uso on public.clientes;
create policy clientes_uso on public.clientes for select to authenticated using (public.meu_papel() in ('entregador','comercio'));
drop policy if exists clientes_cadastrar on public.clientes;
create policy clientes_cadastrar on public.clientes for insert to authenticated with check (public.meu_papel() in ('entregador','comercio'));

-- Acertos e fechamentos: cada um vê os seus
drop policy if exists acertos_entregador on public.acertos;
create policy acertos_entregador on public.acertos for select to authenticated using (entregador_id = public.meu_entregador());
drop policy if exists fech_proprios on public.fechamentos;
create policy fech_proprios on public.fechamentos for select to authenticated
  using (entregador_id = public.meu_entregador() or comercio_id = public.meu_comercio());

-- =====================================================================
-- Fotos de comprovante (Storage privado)
--   caminho: <entrega_id>/<arquivo>.jpg
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('comprovantes', 'comprovantes', false)
on conflict (id) do nothing;

drop policy if exists comprovante_enviar on storage.objects;
create policy comprovante_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'comprovantes' and exists (
    select 1 from public.entregas e
    where e.id::text = split_part(name, '/', 1) and e.entregador_id = public.meu_entregador()));

drop policy if exists comprovante_ver on storage.objects;
create policy comprovante_ver on storage.objects for select to authenticated
  using (bucket_id = 'comprovantes' and (public.sou_central() or exists (
    select 1 from public.entregas e
    where e.id::text = split_part(name, '/', 1)
      and (e.entregador_id = public.meu_entregador() or e.comercio_id = public.meu_comercio()))));

-- Atualização ao vivo (o app recebe novas entregas na hora)
do $$ begin
  alter publication supabase_realtime add table public.entregas;
exception when duplicate_object then null; end $$;
