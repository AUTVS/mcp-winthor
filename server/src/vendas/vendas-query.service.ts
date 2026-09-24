import { Injectable } from '@nestjs/common';
import { clampPage, clampPageSize } from '../config/limits';
import { GridResult } from '../winthor/winthor-mobile.types';
import {
  finalizarLinhas,
  LinhaFaturamento,
  metricasDisponiveis,
} from './agregacao';
import { medirCobertura, motivoCoberturaIncompleta } from './cobertura';
import { executar, consultar } from './duckdb';
import { Dia, Janela } from './periodo-janela';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';

export type DimensaoLocal = 'cliente' | 'filial' | 'rca' | 'emitente';

export const DIMENSOES_LOCAIS: DimensaoLocal[] = [
  'cliente',
  'filial',
  'rca',
  'emitente',
];

const DIM_CONFIG: Record<
  DimensaoLocal,
  {
    tabela: string;
    idCol: string;
    saidaCodigo: string;
    saidaNome: string;
  }
> = {
  cliente: {
    tabela: 'dim_cliente',
    idCol: 'dim_cliente_id',
    saidaCodigo: 'CODIGO_CLIENTE',
    saidaNome: 'NOME_CLIENTE',
  },
  filial: {
    tabela: 'dim_filial',
    idCol: 'dim_filial_id',
    saidaCodigo: 'CODIGO_FILIAL',
    saidaNome: 'NOME_FILIAL',
  },
  rca: {
    tabela: 'dim_rca',
    idCol: 'dim_rca_id',
    saidaCodigo: 'CODIGO_RCA',
    saidaNome: 'NOME_RCA',
  },
  emitente: {
    tabela: 'dim_emitente',
    idCol: 'dim_emitente_id',
    saidaCodigo: 'CODIGO_EMITENTE',
    saidaNome: 'NOME_EMITENTE',
  },
};

export interface ArgsAgregacaoLocal {
  dimensao: DimensaoLocal;
  filiais: string[];
  janela: Janela;
  posicaoPedido: string;
  margemMinLucro?: string;
  listaCliente?: string[];
  listaRca?: string[];
  listaEmitente?: string[];
  page?: number;
  pageSize?: number;
}

export type ResultadoLocal =
  | { atendivel: false; motivo: string; diasFaltantes?: Dia[] }
  | { atendivel: true; resultado: GridResult };

interface LinhaAgregada extends Record<string, unknown> {
  chave: string | null;
  nome: string | null;
  qt: number;
  valor: number | null;
  custo: number | null;
  sem_custo: number;
}

@Injectable()
export class VendasQueryService {
  constructor(
    private readonly metaDb: VendasMetaDbService,
    private readonly fatoDb: VendasFatoDbService,
  ) {}

  async agregar(args: ArgsAgregacaoLocal): Promise<ResultadoLocal> {
    const instanciaId = this.metaDb.instanciaId();
    if (instanciaId === null) {
      return { atendivel: false, motivo: 'servidor ainda não configurado' };
    }

    if (!args.filiais.length) {
      return { atendivel: false, motivo: 'nenhuma filial resolvida' };
    }

    const margem = args.margemMinLucro ?? '100';
    if (margem !== '100') {
      return {
        atendivel: false,
        motivo: `margemMinLucro=${margem} não é reproduzível na base local`,
      };
    }

    const rotulo = this.rotuloDaPosicao(instanciaId, args.posicaoPedido);
    if (rotulo === undefined) {
      return {
        atendivel: false,
        motivo:
          `o rótulo da posição ${args.posicaoPedido} ainda não foi aprendido ` +
          `deste ERP`,
      };
    }

    const cobertura = this.conferirCobertura(instanciaId, args);
    if (!cobertura.completa) {
      return {
        atendivel: false,
        motivo: cobertura.motivo,
        diasFaltantes: cobertura.faltantes,
      };
    }

    return {
      atendivel: true,
      resultado: await this.montarResultado(
        instanciaId,
        args,
        rotulo,
        cobertura,
      ),
    };
  }

  private rotuloDaPosicao(
    instanciaId: number,
    codigo: string,
  ): string | null | undefined {
    if (codigo === '0') return null;
    const linha = this.metaDb
      .banco()
      .prepare(
        'SELECT rotulo FROM dim_posicao WHERE instancia_id = ? AND codigo = ?',
      )
      .get(instanciaId, codigo) as { rotulo: string } | undefined;
    return linha?.rotulo;
  }

  /**
   * Delega ao predicado compartilhado — ver `cobertura.ts`.
   *
   * Antes esta conta vivia aqui em duas queries, e outra versão dela no endpoint de
   * status, e uma terceira na tool MCP. A do status contava só `DISTINCT dia` e por
   * isso o painel dizia "Cacheado" para janelas que esta função recusava.
   */
  private conferirCobertura(
    instanciaId: number,
    args: ArgsAgregacaoLocal,
  ): Cobertura {
    const resumo = medirCobertura(this.metaDb.banco(), {
      instanciaId,
      janela: args.janela,
      filiais: args.filiais,
    });

    if (!resumo.dias) {
      return { completa: false, motivo: 'janela vazia', faltantes: [] };
    }

    if (resumo.completa) {
      return {
        completa: true,
        motivo: '',
        faltantes: [],
        atualizadoEm: resumo.atualizadoEm ?? undefined,
        suspeitos: resumo.suspeitos,
      };
    }

    return {
      completa: false,
      motivo: motivoCoberturaIncompleta(resumo),
      faltantes: resumo.faltantes,
    };
  }

  private async montarResultado(
    instanciaId: number,
    args: ArgsAgregacaoLocal,
    rotulo: string | null,
    cobertura: Cobertura,
  ): Promise<GridResult> {
    const dim = DIM_CONFIG[args.dimensao];
    const fato = await this.fatoDb.conexao();
    const metaPath = this.metaDb.caminhoArquivo().replace(/'/g, "''");

    await executar(
      fato,
      `ATTACH '${metaPath}' AS meta (TYPE SQLITE, READ_ONLY)`,
    );

    const params: unknown[] = [
      instanciaId,
      args.janela.dataInicio,
      args.janela.dataFim,
    ];
    const onde: string[] = [
      'p.instancia_id = ?',
      'p.dia BETWEEN ? AND ?',
      `p.codigo_filial IN (${args.filiais.map(() => '?').join(',')})`,
    ];
    params.push(...args.filiais);

    if (rotulo !== null) {
      onde.push('p.posicao_pedido = ?');
      params.push(rotulo);
    }

    const idPorTabela: Record<string, string> = {
      dim_cliente: 'dim_cliente_id',
      dim_rca: 'dim_rca_id',
      dim_emitente: 'dim_emitente_id',
    };
    for (const [lista, tabela] of [
      [args.listaCliente, 'dim_cliente'],
      [args.listaRca, 'dim_rca'],
      [args.listaEmitente, 'dim_emitente'],
    ] as const) {
      if (lista?.length) {
        onde.push(
          `EXISTS (SELECT 1 FROM meta.${tabela} f WHERE f.id = p.${idPorTabela[tabela]} AND f.codigo IN (${lista.map(() => '?').join(',')}))`,
        );
        params.push(...lista.map(String));
      }
    }

    const sql = `
      SELECT d.codigo AS chave, MAX(d.nome) AS nome,
             COUNT(*) AS qt,
             SUM(p.valor_pedido) AS valor,
             SUM(p.custo_financeiro) AS custo,
             SUM(CASE WHEN p.custo_financeiro IS NULL THEN 1 ELSE 0 END) AS sem_custo
        FROM pedido p
        JOIN meta.${dim.tabela} d ON d.id = p.${dim.idCol}
       WHERE ${onde.join(' AND ')}
         AND d.instancia_id = ?
       GROUP BY d.codigo
       ORDER BY valor DESC`;

    params.push(instanciaId);

    const linhas = await consultar<LinhaAgregada>(fato, sql, params as never[]);

    const custoDisponivel = linhas.every((l) => Number(l.sem_custo) === 0);

    const itens: LinhaFaturamento[] = linhas.map((l) => ({
      NIVEL: args.dimensao,
      [dim.saidaCodigo]: l.chave ?? '',
      [dim.saidaNome]: l.nome ?? '',
      QT_PEDIDOS: Number(l.qt),
      VALOR_FATURADO: Number(l.valor ?? 0),
      CUSTO_FINANCEIRO: Number(l.custo ?? 0),
    }));
    finalizarLinhas(itens, { custoDisponivel });

    const page = clampPage(args.page);
    const pageSize = clampPageSize(args.pageSize);
    const inicio = (page - 1) * pageSize;
    const pagina = itens.slice(inicio, inicio + pageSize);

    const somar = (campo: string) =>
      itens.reduce((s, l) => s + Number(l[campo] ?? 0), 0);

    const avisos: string[] = [];
    if (!custoDisponivel) {
      avisos.push(
        'Parte dos pedidos não tem CUSTO_FINANCEIRO na base; lucro e margem ficaram de fora.',
      );
    }
    if (cobertura.suspeitos) {
      avisos.push(
        `${cobertura.suspeitos} dia(s) foram gravados depois de saírem do alcance do enum de período — confira contra o ERP antes de decidir com base neles.`,
      );
    }

    return {
      items: pagina,
      count: pagina.length,
      page,
      pageSize,
      total: itens.length,
      totalPages: Math.ceil(itens.length / pageSize) || 0,
      totalizer: {
        QT_PEDIDOS: somar('QT_PEDIDOS'),
        VALOR_FATURADO: Math.round(somar('VALOR_FATURADO') * 100) / 100,
        ...(custoDisponivel
          ? { VALOR_LUCRO: Math.round(somar('VALOR_LUCRO') * 100) / 100 }
          : {}),
      },
      filiaisAplicadas: args.filiais.map(String),
      fonte: 'base-local',
      agrupadoPor: args.dimensao,
      metricas: metricasDisponiveis(custoDisponivel),
      cachedAt: cobertura.atualizadoEm,
      ...(avisos.length ? { hint: avisos.join(' ') } : {}),
    };
  }
}

interface Cobertura {
  completa: boolean;
  motivo: string;
  faltantes: Dia[];
  atualizadoEm?: string;
  suspeitos?: number;
}
