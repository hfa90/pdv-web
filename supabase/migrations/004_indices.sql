-- Índices de chaves estrangeiras (recomendação do advisor de performance)
create index if not exists vendas_operador_idx on public.vendas(operador_id);
create index if not exists vendas_cliente_idx on public.vendas(cliente_id);
create index if not exists vendas_cancelada_por_idx on public.vendas(cancelada_por);
create index if not exists estoque_mov_venda_idx on public.estoque_movimentos(venda_id);
create index if not exists estoque_mov_usuario_idx on public.estoque_movimentos(usuario_id);
create index if not exists caixa_mov_empresa_idx on public.caixa_movimentos(empresa_id);
create index if not exists caixa_mov_usuario_idx on public.caixa_movimentos(usuario_id);
create index if not exists venda_itens_empresa_idx on public.venda_itens(empresa_id);
create index if not exists venda_itens_removido_por_idx on public.venda_itens(removido_por);
create index if not exists venda_pag_empresa_idx on public.venda_pagamentos(empresa_id);
