-- =====================================================================
-- Movvi+ — etapa 4/5/6: painel do comércio, fechamento e limpeza de fotos
-- =====================================================================

-- Proteções: só a central muda taxa, adicional e acerto.
-- Comércio e entregador sempre usam a taxa cadastrada do comércio.
create or replace function public.entregas_antes_salvar()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_central boolean := public.sou_central();
begin
  if not v_central then
    if tg_op = 'INSERT' then
      select coalesce(c.taxa, 8), coalesce(c.endereco, new.coleta_endereco)
        into new.taxa_cobrada, new.coleta_endereco
        from public.comercios c where c.id = new.comercio_id;
      new.adicional := false; new.acertado := false; new.acerto_id := null;
    else
      new.taxa_cobrada := old.taxa_cobrada; new.adicional := old.adicional;
      new.comercio_id := old.comercio_id;   new.acertado := old.acertado;
      new.acerto_id := old.acerto_id;       new.numero := old.numero;
    end if;
  end if;
  new.ganho_entregador := public.calcular_ganho(new.taxa_cobrada, new.adicional);
  if new.status = 'entregue' and new.entregue_em is null then new.entregue_em := now(); end if;
  if new.status = 'aceita'   and new.aceito_em   is null then new.aceito_em   := now(); end if;
  if new.status = 'em_rota'  and new.coletado_em is null then new.coletado_em := now(); end if;
  if tg_op = 'INSERT' and new.criado_por is null then new.criado_por := auth.uid(); end if;
  return new;
end $$;

-- Comércio vê o nome do entregador que está levando as entregas dele
drop policy if exists entregador_para_comercio on public.entregadores;
create policy entregador_para_comercio on public.entregadores for select to authenticated
  using (public.meu_comercio() is not null and exists (
    select 1 from public.entregas e where e.entregador_id = entregadores.id and e.comercio_id = public.meu_comercio()));

-- Comércio pode cancelar entrega que ainda ninguém aceitou
drop policy if exists entregas_comercio_cancelar on public.entregas;
create policy entregas_comercio_cancelar on public.entregas for update to authenticated
  using (comercio_id = public.meu_comercio() and status = 'solicitado' and entregador_id is null)
  with check (comercio_id = public.meu_comercio() and entregador_id is null and status in ('solicitado','cancelado'));

-- Central pode apagar fotos (limpeza automática após 7 dias)
drop policy if exists comprovante_apagar on storage.objects;
create policy comprovante_apagar on storage.objects for delete to authenticated
  using (bucket_id = 'comprovantes' and public.sou_central());

-- Um fechamento por semana para cada entregador / comércio
create unique index if not exists fech_semana_entregador on public.fechamentos (semana_inicio, entregador_id);
create unique index if not exists fech_semana_comercio on public.fechamentos (semana_inicio, comercio_id);
