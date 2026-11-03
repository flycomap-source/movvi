-- =====================================================================
-- Movvi+ — travas curtas (quem pega primeiro): código de cliente,
-- aceite de oferta pelo entregador. Igual ao "acquire" do app original.
-- =====================================================================
create table if not exists public.travas (
  path    text primary key,
  holder  text not null,
  expira  timestamptz not null
);
alter table public.travas enable row level security; -- ninguém acessa direto; só pela função abaixo

create or replace function public.doc_acquire(p_path text, p_holder text, p_ttl_ms int default 30000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ttl int := least(greatest(coalesce(nullif(p_ttl_ms, 0), 30000), 1000), 600000);
        v_exp timestamptz; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'sem login' using errcode = '42501'; end if;
  insert into public.travas (path, holder, expira)
  values (p_path, p_holder, now() + make_interval(secs => v_ttl / 1000.0))
  on conflict (path) do update
    set holder = excluded.holder, expira = excluded.expira
    where public.travas.expira < now() or public.travas.holder = excluded.holder
  returning true, expira into v_ok, v_exp;
  if v_ok then
    return jsonb_build_object('acquired', true, 'holder', p_holder, 'expiresAt', v_exp);
  end if;
  select expira into v_exp from public.travas where path = p_path;
  return jsonb_build_object('acquired', false, 'expiresAt', v_exp);
end $$;

-- limpeza das travas vencidas há mais de um dia
create or replace function public.limpar_travas() returns void
language sql security definer set search_path = public as $$
  delete from public.travas where expira < now() - interval '1 day'
$$;
