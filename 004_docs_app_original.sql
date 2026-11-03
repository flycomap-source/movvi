-- =====================================================================
-- Movvi+ — armazenamento do app original (mesmo formato de documentos)
-- Cada documento tem um caminho, ex.: "entregas/<uid>/pedidos/<id>"
-- =====================================================================
create table if not exists public.docs (
  path        text primary key,
  col         text not null,             -- coleção (caminho sem o id)
  id          text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index if not exists docs_col_idx        on public.docs (col);
create index if not exists docs_col_data_idx   on public.docs (col, (data->>'data'));
create index if not exists docs_col_status_idx on public.docs (col, (data->>'status'));
alter table public.docs replica identity full;

create or replace function public.docs_antes_salvar() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists docs_antes_salvar on public.docs;
create trigger docs_antes_salvar before insert or update on public.docs
  for each row execute function public.docs_antes_salvar();

-- Quem já foi liberado pela central (vínculo ativo) ou é a central
create or replace function public.doc_aprovado() returns boolean
language sql stable security definer set search_path = public as $$
  select public.sou_central() or exists (
    select 1 from public.docs
    where path = 'vinculos/' || auth.uid()::text
      and coalesce(data->>'ativo', 'true') <> 'false')
$$;

-- Área privada de cada pessoa: data/users/<id>/...
create or replace function public.doc_privado_de_outro(p text) returns boolean
language sql stable as $$
  select p like 'data/users/%' and split_part(p, '/', 3) <> coalesce(auth.uid()::text, '')
$$;

alter table public.docs enable row level security;

drop policy if exists docs_central on public.docs;
create policy docs_central on public.docs for all to authenticated
  using (public.sou_central() and not public.doc_privado_de_outro(path))
  with check (public.sou_central() and not public.doc_privado_de_outro(path));

drop policy if exists docs_aprovado on public.docs;
drop policy if exists docs_aprovado_ler on public.docs;
create policy docs_aprovado_ler on public.docs for select to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path));
-- liberados escrevem em tudo, menos nos vínculos (liberação é só da central)
drop policy if exists docs_aprovado_inserir on public.docs;
create policy docs_aprovado_inserir on public.docs for insert to authenticated
  with check (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%');
drop policy if exists docs_aprovado_mudar on public.docs;
create policy docs_aprovado_mudar on public.docs for update to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%')
  with check (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%');
drop policy if exists docs_aprovado_apagar on public.docs;
create policy docs_aprovado_apagar on public.docs for delete to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%');

-- Ainda sem liberação: lê o que é dele; escreve o que é dele, menos o vínculo
drop policy if exists docs_proprios on public.docs;
drop policy if exists docs_proprios_ler on public.docs;
create policy docs_proprios_ler on public.docs for select to authenticated
  using (auth.uid() is not null and (path like '%/' || auth.uid()::text or path like '%/' || auth.uid()::text || '/%'));
drop policy if exists docs_proprios_escrever on public.docs;
create policy docs_proprios_escrever on public.docs for insert to authenticated
  with check (auth.uid() is not null and path not like 'vinculos/%' and (path like '%/' || auth.uid()::text or path like '%/' || auth.uid()::text || '/%'));
drop policy if exists docs_proprios_mudar on public.docs;
create policy docs_proprios_mudar on public.docs for update to authenticated
  using (auth.uid() is not null and path not like 'vinculos/%' and (path like '%/' || auth.uid()::text or path like '%/' || auth.uid()::text || '/%'))
  with check (auth.uid() is not null and path not like 'vinculos/%' and (path like '%/' || auth.uid()::text or path like '%/' || auth.uid()::text || '/%'));
drop policy if exists docs_proprios_apagar on public.docs;
create policy docs_proprios_apagar on public.docs for delete to authenticated
  using (auth.uid() is not null and path not like 'vinculos/%' and (path like '%/' || auth.uid()::text or path like '%/' || auth.uid()::text || '/%'));

drop policy if exists docs_config on public.docs;
create policy docs_config on public.docs for select to authenticated
  using (path like 'config/%');

-- update parcial (como o update do app original): junta os campos novos
create or replace function public.doc_update(p_path text, p_patch jsonb) returns boolean
language plpgsql set search_path = public as $$
begin
  update public.docs set data = data || p_patch where path = p_path;
  if not found then
    raise exception 'documento não encontrado: %', p_path using errcode = 'P0002';
  end if;
  return true;
end $$;

-- ao vivo
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Fotos (comprovantes e comandas) — nomes aleatórios, leitura pelo link
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', true)
on conflict (id) do nothing;

drop policy if exists fotos_enviar on storage.objects;
create policy fotos_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.doc_aprovado());
drop policy if exists fotos_listar on storage.objects;
create policy fotos_listar on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and public.doc_aprovado());
drop policy if exists fotos_apagar on storage.objects;
create policy fotos_apagar on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and public.sou_central());
