/**
 * Aritmética das linhas agregadas de faturamento.
 *
 * Extraída de `somarPorCliente` para ser a **única** implementação usada pelos
 * dois caminhos — a varredura em processo do `WinthorMobileService` e a consulta
 * à base local. Duas implementações do mesmo número é como os totais passam a
 * discordar em silêncio, e o serviço já evita isso de propósito em outro ponto
 * (`agregarFaturamento` delega `rca` ao mesmo caminho de `wt_lucratividade_por_rca`,
 * justamente para não existirem duas rotas para o mesmo valor).
 */

export type LinhaFaturamento = Record<string, unknown>;

/** Dinheiro com 2 casas, sem arrastar erro de ponto flutuante nas somas. */
export function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/** Coerção defensiva: o WinThor mistura número e string no mesmo campo. */
export function num(valor: unknown): number {
  const n = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Completa as linhas já somadas com lucro, margem e participação.
 *
 * Espera `QT_PEDIDOS`, `VALOR_FATURADO` e `CUSTO_FINANCEIRO` **já agregados**.
 *
 * Lucro e margem saem das SOMAS, nunca da média de `PERCENTUAL_LUCRO` das linhas:
 * média de percentual é uma quantidade sem significado, e a linha do pedido traz
 * justamente esse campo por linha, o que torna o erro tentador.
 *
 * `custoDisponivel: false` derruba dinheiro derivado em vez de publicar lucro
 * calculado sobre custo ausente — mesma regra de `metricaNumerica` e do aviso de
 * `agregarPorDimensao`: sem custo, só quantidade e faturamento são afirmáveis.
 */
export function finalizarLinhas(
  linhas: LinhaFaturamento[],
  opts: { custoDisponivel: boolean },
): LinhaFaturamento[] {
  const totalGeral = linhas.reduce((s, l) => s + num(l.VALOR_FATURADO), 0);

  for (const linha of linhas) {
    const faturado = num(linha.VALOR_FATURADO);

    if (opts.custoDisponivel) {
      const custo = num(linha.CUSTO_FINANCEIRO);
      linha.CUSTO_FINANCEIRO = arredondar(custo);
      linha.VALOR_LUCRO = arredondar(faturado - custo);
      linha.PERC_LUCRO = faturado
        ? arredondar(((faturado - custo) / faturado) * 100)
        : 0;
    } else {
      delete linha.CUSTO_FINANCEIRO;
      delete linha.VALOR_LUCRO;
      delete linha.PERC_LUCRO;
    }

    linha.VALOR_FATURADO = arredondar(faturado);
    linha.PARTICIPACAO = totalGeral
      ? arredondar((faturado / totalGeral) * 100)
      : 0;
  }

  return linhas;
}

/** Métricas que as linhas realmente carregam, para o assistente não supor. */
export function metricasDisponiveis(custoDisponivel: boolean): string[] {
  return custoDisponivel
    ? ['QT_PEDIDOS', 'VALOR_FATURADO', 'VALOR_LUCRO', 'PERC_LUCRO']
    : ['QT_PEDIDOS', 'VALOR_FATURADO'];
}
