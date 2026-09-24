import { Db } from '../vendas/sqlite';

export interface ResumoCoberturaEstoque {
  completa: boolean;
  filiaisEsperadas: number;
  filiaisCobertas: number;
  faltantes: string[];
  atualizadoEm?: string;
}

export function medirCoberturaEstoque(
  db: Db,
  instanciaId: number,
  filiais: string[],
): ResumoCoberturaEstoque {
  const esperadas = [...new Set(filiais.map(String))].sort();
  if (!esperadas.length) {
    return {
      completa: false,
      filiaisEsperadas: 0,
      filiaisCobertas: 0,
      faltantes: [],
    };
  }

  const cobertas = db
    .prepare(
      `SELECT codigo_filial, atualizado_em
         FROM cobertura
        WHERE instancia_id = ?`,
    )
    .all(instanciaId) as { codigo_filial: string; atualizado_em: string }[];

  const mapa = new Map(
    cobertas.map((c) => [c.codigo_filial, c.atualizado_em]),
  );
  const faltantes = esperadas.filter((f) => !mapa.has(f));
  const atualizadoEm = cobertas.length
    ? cobertas
        .map((c) => c.atualizado_em)
        .sort()
        .at(0)
    : undefined;

  return {
    completa: faltantes.length === 0,
    filiaisEsperadas: esperadas.length,
    filiaisCobertas: esperadas.length - faltantes.length,
    faltantes,
    atualizadoEm,
  };
}

export function motivoCoberturaIncompletaEstoque(
  resumo: ResumoCoberturaEstoque,
): string {
  if (resumo.completa) return '';
  if (resumo.filiaisCobertas === 0) {
    return 'base local de estoque vazia para as filiais solicitadas';
  }
  return (
    `cobertura incompleta: ${resumo.filiaisCobertas} de ` +
    `${resumo.filiaisEsperadas} filial(is) — faltam: ${resumo.faltantes.join(', ')}`
  );
}
