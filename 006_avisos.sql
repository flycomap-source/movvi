-- =====================================================================
-- Movvi+ — avisos no celular com o app fechado (Web Push)
-- =====================================================================
create extension if not exists pg_net;

-- celulares que aceitaram receber avisos (um por navegador/aparelho)
create table if not exists public.push_inscricoes (
  endpoint  text primary key,
  user_id   uuid not null default auth.uid(),
  p256dh    text not null,
  auth      text not null,
  criado_em timestamptz not null default now()
);
alter table public.push_inscricoes enable row level security;
drop policy if exists push_proprio on public.push_inscricoes;
create policy push_proprio on public.push_inscricoes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- chaves do aviso: criadas pela função "avisar" na primeira vez; só o servidor lê
create table if not exists public.push_config (
  id      int primary key,
  publica text not null,
  privada text not null
);
alter table public.push_config enable row level security;

-- quando entra uma oferta, entrega ou pedido de comércio, chama a função que manda o aviso
create or replace function public.avisar_doc_novo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://ilhizctomafdutxcdhxa.supabase.co/functions/v1/avisar',
    body := jsonb_build_object('path', new.path),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 5000);
  return new;
exception when others then
  return new;  -- aviso nunca pode travar o lançamento da entrega
end $$;

drop trigger if exists avisar_doc_novo on public.docs;
create trigger avisar_doc_novo after insert on public.docs
  for each row
  when (new.col like 'entregas/%/ofertas' or new.col like 'entregas/%/pedidos'
        or new.col = 'abertos' or new.col like 'lojas/%/pedidos')
  execute function public.avisar_doc_novo();
