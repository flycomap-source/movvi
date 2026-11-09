-- Recados do comércio/central para o entregador: o aviso no celular sai também para recados/<id>
drop trigger if exists avisar_doc_novo on public.docs;
create trigger avisar_doc_novo after insert on public.docs
  for each row
  when (new.col like 'entregas/%/ofertas' or new.col like 'entregas/%/pedidos'
        or new.col = 'abertos' or new.col like 'lojas/%/pedidos' or new.col = 'recados')
  execute function public.avisar_doc_novo();
