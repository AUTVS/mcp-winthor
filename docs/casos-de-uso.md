# Casos de uso

O assistente de IA (Cursor, Claude, ChatGPT) fala com o wt.ai em linguagem natural. Cada pergunta vira uma ou mais tools MCP. Vendas e estoque pesados leem a **base local** (DuckDB + SQLite); cadastro, inadimplência e lucratividade vão **ao vivo** na API do WinThor.

Antes de consultar números, o assistente costuma checar cobertura com `wt_vendas_base_local` ou `wt_estoque_base_local`. Se a cópia estiver vazia ou atrasada, dispara `wt_vendas_sincronizar` ou `wt_estoque_sincronizar`.

## Diretoria — vendas do mês vs. o anterior

**Pergunta:** “Como foram as vendas deste mês comparado ao mês passado, por filial?”

| | |
| --- | --- |
| Tools | `wt_vendas_base_local`, `wt_vendas_sincronizar`, `wt_faturamento_agregado` |
| Origem | Base local de vendas (DuckDB). Sem ela, o WinThor não recorta data livre. |

O assistente confirma a cobertura (mês atual e anterior), agrupa faturamento por `filial` e compara os dois recortes. `agruparPor: filial` é exato e não varre pedido a pedido.

## Compras — ruptura e cobertura de estoque

**Pergunta:** “Quais produtos estão sem saldo na filial 2? A cobertura da base está completa?”

| | |
| --- | --- |
| Tools | `wt_estoque_base_local`, `wt_estoque_sincronizar`, `wt_estoque_por_filial` |
| Origem | Base local quando a filial já foi sincronizada; senão, API ao vivo (`/wms/api/v1/produto/buscar-produtos`). |

`wt_estoque_por_filial` exige `codigoFilial`. Dá para filtrar por código ou descrição do produto. `completo` varre todas as filiais visíveis; `atualizacao` só refresca as que passaram da validade.

## Financeiro — carteira em atraso

**Pergunta:** “Quanto está a receber na carteira da filial 1, e como isso se espalha por faixa de atraso?”

| | |
| --- | --- |
| Tools | `wt_inadimplencia_valor_carteira`, `wt_inadimplencia_por_dia_atraso` (e, se precisar, `wt_inadimplencia_por_valor`) |
| Origem | Rotinas mobile do WinThor, ao vivo. A carteira é posição atual — não depende de período. |

Lookups auxiliares (`wt_inadimplencia_pesquisar_cliente`, `wt_inadimplencia_pesquisar_supervisor`, `wt_inadimplencia_pesquisar_tipo_cobranca`) montam os filtros antes da consulta.

## Comercial — lucratividade por RCA

**Pergunta:** “Quais RCAs venderam com melhor margem neste período?”

| | |
| --- | --- |
| Tools | `wt_lucratividade_por_rca` |
| Origem | Rotina mobile W106, ao vivo. Agregado nativo: valor, custo financeiro, CMV e lucro. |

Para descer ao pedido: `wt_lucratividade_pedidos`, depois `wt_lucratividade_itens_pedido` ou `wt_lucratividade_faltas_pedido` com `codigoPedido` e `nomeFilial`.

## Atendimento — cliente e pedidos

**Pergunta:** “Ache o cliente Silva e mostre os pedidos ativos dele.”

| | |
| --- | --- |
| Tools | `wt_buscar_clientes`, `wt_buscar_pedidos_venda`, `wt_list_filiais` |
| Origem | API WinThor ao vivo (cache curto só na lista de filiais). |

`wt_buscar_clientes` filtra por código e/ou nome — sem filtro varre a base inteira. Pedidos aceitam `status` (padrão `ATIVO`) e data da última alteração.

## Operação — faturamento agregado

**Pergunta:** “Quanto cada supervisor faturou neste recorte? E o ranking de clientes cabe?”

| | |
| --- | --- |
| Tools | `wt_faturamento_agregado` (e `wt_vendas_base_local` se o recorte for data livre) |
| Origem | Base local para `dataInicio`/`dataFim`; senão, período fechado do WinThor. |

`filial` e `supervisor` são exatos e não varrem. `rca` usa o agregado nativo. `cliente` só cabe em recortes menores; se não couber, a resposta cai para `filial` e avisa em `rebaixado`.

---

Precisa de uma tool nova, um recorte que o ERP ainda não entrega, ou ajuda para implantar no time? [Fale comigo](contato.md).
