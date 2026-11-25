-- =====================================================================
-- Movvi+ — proteção contra vazamento de dados
-- Antes: qualquer entregador/comércio liberado conseguia LER e ALTERAR
-- qualquer documento (base completa de clientes, senhas de acesso de
-- outras pessoas, acessos, chaves Pix dos clientes).
-- Agora: esses caminhos sensíveis ficam só com a central; cada pessoa
-- continua lendo/alterando só o que é dela (senhas/<seu id>, acessos/<seu id>).
-- =====================================================================

-- caminhos que só a central pode ler/alterar por inteiro
create or replace function public.doc_sensivel(p text) returns boolean
language sql immutable as $$
  select p like 'clientes/%'
      or p like 'senhas/%'
      or p like 'acessos/%'
      or p like 'pixClientes/%'
$$;

-- central ou pessoa da equipe com "acesso à central" ligado (vínculo ativo)
create or replace function public.acesso_central() returns boolean
language sql stable security definer set search_path = public as $$
  select public.sou_central() or exists (
    select 1 from public.docs
    where path = 'vinculos/' || auth.uid()::text
      and coalesce(data->>'ativo', 'true') <> 'false'
      and coalesce(data->>'acessoCentral', 'false') = 'true')
$$;

-- leitura dos liberados: tudo do trabalho, menos os caminhos sensíveis
drop policy if exists docs_aprovado_ler on public.docs;
create policy docs_aprovado_ler on public.docs for select to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path) and (not public.doc_sensivel(path) or public.acesso_central()));

-- escrita dos liberados: também não mexem nos sensíveis de outras pessoas
-- (o próprio senhas/<id> e acessos/<id> continuam pelas regras docs_proprios_*)
drop policy if exists docs_aprovado_inserir on public.docs;
create policy docs_aprovado_inserir on public.docs for insert to authenticated
  with check (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%'
              and (not public.doc_sensivel(path) or public.acesso_central()));
drop policy if exists docs_aprovado_mudar on public.docs;
create policy docs_aprovado_mudar on public.docs for update to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%' and (not public.doc_sensivel(path) or public.acesso_central()))
  with check (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%' and (not public.doc_sensivel(path) or public.acesso_central()));
drop policy if exists docs_aprovado_apagar on public.docs;
create policy docs_aprovado_apagar on public.docs for delete to authenticated
  using (public.doc_aprovado() and not public.doc_privado_de_outro(path) and path not like 'vinculos/%' and (not public.doc_sensivel(path) or public.acesso_central()));

-- consulta de UMA chave Pix por vez (para vir preenchida na finalização), sem permitir copiar a lista
create or replace function public.pix_do_cliente(p_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.doc_aprovado() and p_id ~ '^[a-z0-9_-]{3,80}$'
    then (select jsonb_build_object('chave', data->>'chave', 'nome', data->>'nome')
            from public.docs where path = 'pixClientes/' || p_id)
    end
$$;
revoke all on function public.pix_do_cliente(text) from public, anon;
grant execute on function public.pix_do_cliente(text) to authenticated;

-- o entregador salva a chave Pix do cliente sem poder ler a lista inteira
create or replace function public.pix_salvar(p_id text, p_dados jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.doc_aprovado() or p_id !~ '^[a-z0-9_-]{3,80}$' then return false; end if;
  insert into public.docs(path, col, id, data)
  values ('pixClientes/' || p_id, 'pixClientes', p_id,
          jsonb_build_object('chave', left(coalesce(p_dados->>'chave',''),120), 'nome', left(coalesce(p_dados->>'nome',''),120),
                             'cliente', left(coalesce(p_dados->>'cliente',''),120), 'telefone', left(coalesce(p_dados->>'telefone',''),30),
                             'endereco', left(coalesce(p_dados->>'endereco',''),200), 'em', now()))
  on conflict (path) do update set data = excluded.data;
  return true;
end $$;
revoke all on function public.pix_salvar(text, jsonb) from public, anon;
grant execute on function public.pix_salvar(text, jsonb) to authenticated;
