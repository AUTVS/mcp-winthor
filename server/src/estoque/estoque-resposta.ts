/** Extrai lista de produtos do payload do WMS. */
export function extrairItensEstoque(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  const registro = data as Record<string, unknown>;
  if (Array.isArray(registro.items)) return registro.items;
  if (Array.isArray(registro.content)) return registro.content;
  if (Array.isArray(registro.produtos)) return registro.produtos;
  if (Array.isArray(registro.data)) return registro.data;
  return [];
}

/** Total declarado pelo upstream, quando existir. */
export function extrairTotalEstoque(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const registro = data as Record<string, unknown>;
  const candidatos = [
    registro.total,
    registro.totalElements,
    registro.totalCount,
    registro.count,
  ];
  for (const valor of candidatos) {
    const n = numero(valor);
    if (n !== null && n >= 0) return Math.trunc(n);
  }
  return undefined;
}

export function codigoProduto(item: Record<string, unknown>): string | null {
  const candidatos = [
    item.produtoId,
    item.codProd,
    item.codigoProduto,
    item.CODPROD,
    item.id,
    item.codigo,
  ];
  for (const valor of candidatos) {
    const texto = asTexto(valor);
    if (texto) return texto;
  }
  return null;
}

export function descricaoProduto(item: Record<string, unknown>): string | null {
  const candidatos = [
    item.descricao,
    item.DESCRICAO,
    item.nome,
    item.nomeProduto,
  ];
  for (const valor of candidatos) {
    const texto = asTexto(valor);
    if (texto) return texto;
  }
  return null;
}

export function saldoProduto(item: Record<string, unknown>): number | null {
  const candidatos = [
    item.saldo,
    item.quantidade,
    item.qtde,
    item.estoqueDisponivel,
    item.saldoDisponivel,
    item.SALDO,
    item.QT,
  ];
  for (const valor of candidatos) {
    const n = numero(valor);
    if (n !== null) return n;
  }
  return null;
}

export function saldoReservadoProduto(
  item: Record<string, unknown>,
): number | null {
  const candidatos = [
    item.saldoReservado,
    item.quantidadeReservada,
    item.qtReservada,
    item.reservado,
  ];
  for (const valor of candidatos) {
    const n = numero(valor);
    if (n !== null) return n;
  }
  return null;
}

function numero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor.trim())) {
    return Number(valor);
  }
  return null;
}

function asTexto(valor: unknown): string | null {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : null;
}
