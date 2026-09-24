/**
 * Predicado ÚNICO de cobertura da base local.
 *
 * A cobertura é gravada por **par (filial × dia)** — `publicarCobertura` escreve uma
 * linha para cada um. Contar só `DISTINCT dia` responde "algum dia foi visto", que não
 * é a mesma pergunta que "a janela está consultável": com cinco filiais e uma
 * sincronizada, o primeiro dá 100 % dos dias e o segundo, 20 % dos pares.
 *
 * Este módulo existe porque essa conta estava escrita em três lugares — a consulta
 * (que exigia os pares), o endpoint de status (que contava só os dias) e a tool MCP
 * (uma terceira variante). O painel dizia "Cacheado" enquanto a consulta recusava a
 * mesma janela. Toda pergunta sobre cobertura passa por aqui para que card, consulta
 * e tool nunca mais discordem.
 *
 * Funções soltas, e não `@Injectable` — mesmo precedente de `vendas-dimensao.ts`.
 * Assim controller, serviço de consulta e tool chamam sem tocar no grafo de DI.
 */

import {
  Dia,
  Janela,
  diasEntre,
  mesDe,
  primeiroDoMes,
  ultimoDoMes,
} from './periodo-janela';
import type { Db } from './sqlite';

/**
 * Posição em que a base é varrida: `'0'` = todas.
 *
 * Uma varredura serve qualquer filtro de posição aplicado depois, então a cobertura
 * só é gravada nesta posição — e só ela pode ser consultada para decidir completude.
 */
export const POSICAO_COBERTURA = '0';

export interface AlvoCobertura {
  instanciaId: number;
  janela: Janela;
  /** Filiais ESPERADAS. Cobertura parcial delas é cobertura incompleta. */
  filiais: string[];
  posicaoPedido?: string;
}

export interface LinhaDiaCobertura {
  dia: Dia;
  /** Quantas das filiais esperadas têm linha neste dia. */
  filiais: number;
  pedidos: number;
  atualizadoEm: string | null;
  suspeitos: number;
}

export interface ResumoCobertura {
  completa: boolean;
  /** Dias na janela. */
  dias: number;
  /** Dias cobertos em TODAS as filiais esperadas. */
  diasCompletos: number;
  /** `dias × filiais` — a unidade que a consulta realmente exige. */
  paresEsperados: number;
  paresCobertos: number;
  /** Dias sem cobertura completa, em ordem. Vazio quando `completa`. */
  faltantes: Dia[];
  /** `MIN(atualizado_em)` da janela — é a defasagem, não a última escrita. */
  atualizadoEm: string | null;
  suspeitos: number;
}

export interface LinhaMesCobertura {
  /** `YYYY-MM`. */
  mes: string;
  diasEsperados: number;
  diasCobertos: number;
  /** Maior número de filiais visto num dia do mês. */
  filiais: number;
  pedidos: number;
  atualizadoEm: string | null;
}

function normalizarFiliais(filiais: string[]): string[] {
  return [...new Set(filiais.map(String))].filter((c) => c.length > 0);
}

/**
 * Cobertura por dia da janela, restrita às filiais esperadas.
 *
 * Uma query com `GROUP BY dia` serve tanto o resumo quanto a régua mensal — os dois
 * consumidores precisam exatamente do mesmo recorte.
 */
export function lerCoberturaPorDia(
  db: Db,
  alvo: AlvoCobertura,
): Map<Dia, LinhaDiaCobertura> {
  const filiais = normalizarFiliais(alvo.filiais);
  const mapa = new Map<Dia, LinhaDiaCobertura>();
  if (!filiais.length) return mapa;
  if (alvo.janela.dataFim < alvo.janela.dataInicio) return mapa;

  const marcadores = filiais.map(() => '?').join(',');
  const linhas = db
    .prepare(
      `SELECT dia,
              COUNT(DISTINCT codigo_filial) AS filiais,
              SUM(qt_pedidos)               AS pedidos,
              MIN(atualizado_em)            AS atualizado_em,
              SUM(CASE WHEN estado = 'suspeito' THEN 1 ELSE 0 END) AS suspeitos
         FROM cobertura
        WHERE instancia_id = ? AND posicao_pedido = ?
          AND dia BETWEEN ? AND ?
          AND codigo_filial IN (${marcadores})
        GROUP BY dia`,
    )
    .all(
      alvo.instanciaId,
      alvo.posicaoPedido ?? POSICAO_COBERTURA,
      alvo.janela.dataInicio,
      alvo.janela.dataFim,
      ...filiais,
    ) as {
    dia: string;
    filiais: number;
    pedidos: number | null;
    atualizado_em: string | null;
    suspeitos: number | null;
  }[];

  for (const l of linhas) {
    mapa.set(l.dia, {
      dia: l.dia,
      filiais: Number(l.filiais) || 0,
      pedidos: Number(l.pedidos ?? 0),
      atualizadoEm: l.atualizado_em,
      suspeitos: Number(l.suspeitos ?? 0),
    });
  }
  return mapa;
}

export function medirCobertura(db: Db, alvo: AlvoCobertura): ResumoCobertura {
  const dias = diasEntre(alvo.janela.dataInicio, alvo.janela.dataFim);
  const filiais = normalizarFiliais(alvo.filiais);

  // Sem filial esperada não há afirmação possível: a janela não está "completa", ela
  // é INDETERMINADA. Devolver `true` aqui é exatamente como o endpoint antigo dizia
  // "Cacheado" com uma filial de cinco.
  if (!dias.length || !filiais.length) {
    return {
      completa: false,
      dias: dias.length,
      diasCompletos: 0,
      paresEsperados: dias.length * filiais.length,
      paresCobertos: 0,
      faltantes: dias,
      atualizadoEm: null,
      suspeitos: 0,
    };
  }

  const porDia = lerCoberturaPorDia(db, alvo);
  const faltantes: Dia[] = [];
  let paresCobertos = 0;
  let suspeitos = 0;
  let atualizadoEm: string | null = null;

  for (const dia of dias) {
    const linha = porDia.get(dia);
    // Limita ao esperado: filial fora do alvo não pode "compensar" outra faltando.
    const vistas = Math.min(linha?.filiais ?? 0, filiais.length);
    paresCobertos += vistas;
    suspeitos += linha?.suspeitos ?? 0;
    if (vistas < filiais.length) faltantes.push(dia);
    if (
      linha?.atualizadoEm &&
      (atualizadoEm === null || linha.atualizadoEm < atualizadoEm)
    ) {
      atualizadoEm = linha.atualizadoEm;
    }
  }

  return {
    completa: faltantes.length === 0,
    dias: dias.length,
    diasCompletos: dias.length - faltantes.length,
    paresEsperados: dias.length * filiais.length,
    paresCobertos,
    faltantes,
    atualizadoEm,
    suspeitos,
  };
}

/**
 * Frase de recusa da consulta.
 *
 * Mantida byte a byte igual à que `conferirCobertura` produzia: ela viaja no `motivo`
 * das respostas MCP e não vale quebrar de graça.
 */
export function motivoCoberturaIncompleta(r: ResumoCobertura): string {
  return (
    `base local cobre ${r.paresCobertos} de ${r.paresEsperados} pares (dia × filial); ` +
    `${r.faltantes.length} dia(s) sem cobertura completa`
  );
}

/**
 * Régua de cobertura mês a mês dentro da janela.
 *
 * O primeiro e o último mês da janela são parciais por construção (a janela raramente
 * começa dia 1º ou termina no último dia), então `diasEsperados` é recortado pela
 * janela — senão julho apareceria como 27/31 no dia 27 e nunca fecharia.
 */
export function coberturaPorMes(
  db: Db,
  alvo: AlvoCobertura,
): LinhaMesCobertura[] {
  const dias = diasEntre(alvo.janela.dataInicio, alvo.janela.dataFim);
  if (!dias.length) return [];

  const porDia = lerCoberturaPorDia(db, alvo);
  const filiaisEsperadas = normalizarFiliais(alvo.filiais).length;
  const meses = new Map<string, LinhaMesCobertura>();

  for (const dia of dias) {
    const mes = mesDe(dia);
    let linha = meses.get(mes);
    if (!linha) {
      linha = {
        mes,
        diasEsperados: 0,
        diasCobertos: 0,
        filiais: 0,
        pedidos: 0,
        atualizadoEm: null,
      };
      meses.set(mes, linha);
    }

    linha.diasEsperados++;

    const doDia = porDia.get(dia);
    if (!doDia) continue;

    linha.pedidos += doDia.pedidos;
    linha.filiais = Math.max(linha.filiais, doDia.filiais);
    if (filiaisEsperadas > 0 && doDia.filiais >= filiaisEsperadas) {
      linha.diasCobertos++;
    }
    if (
      doDia.atualizadoEm &&
      (linha.atualizadoEm === null || doDia.atualizadoEm < linha.atualizadoEm)
    ) {
      linha.atualizadoEm = doDia.atualizadoEm;
    }
  }

  return [...meses.values()].sort((a, b) => (a.mes < b.mes ? 1 : -1));
}

/**
 * Recorte de um mês pela janela — útil para quem precisa dos limites, não da contagem.
 */
export function janelaDoMes(mes: string, janela: Janela): Janela {
  const inicio = primeiroDoMes(`${mes}-01`);
  const fim = ultimoDoMes(`${mes}-01`);
  return {
    dataInicio: inicio < janela.dataInicio ? janela.dataInicio : inicio,
    dataFim: fim > janela.dataFim ? janela.dataFim : fim,
  };
}

/**
 * Ordenação numérica de código de filial.
 *
 * A coluna é TEXT, então `ORDER BY codigo_filial` devolve `1, 10, 11, 2, 20, 3` —
 * ilegível numa lista que o usuário lê para achar a filial que falta. O `CAST` dá 0
 * para código não numérico, daí o desempate pelo texto.
 */
export const ORDEM_FILIAL = 'CAST(codigo_filial AS INTEGER), codigo_filial';

/** Filiais que já têm alguma cobertura na janela. Subconjunto do alvo. */
export function filiaisComCobertura(
  db: Db,
  instanciaId: number,
  janela: Janela,
): string[] {
  const linhas = db
    .prepare(
      `SELECT DISTINCT codigo_filial
         FROM cobertura
        WHERE instancia_id = ? AND dia BETWEEN ? AND ?
        ORDER BY ${ORDEM_FILIAL}`,
    )
    .all(instanciaId, janela.dataInicio, janela.dataFim) as {
    codigo_filial: string;
  }[];
  return linhas.map((l) => l.codigo_filial);
}
