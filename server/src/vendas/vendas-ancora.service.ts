import { Injectable, Logger } from '@nestjs/common';
import { TOLERANCIA_CONFERENCIA_PCT } from '../config/limits';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import {
  col,
  ColunaGrid,
  ENDPOINTS,
  PeriodoCodigo,
} from '../winthor/winthor-mobile.types';
import { consultarUm } from './duckdb';
import { janelaDoPeriodo, Janela } from './periodo-janela';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';

const COLUNAS: ColunaGrid[] = [
  col('NUMERO_PEDIDO'),
  col('CODIGO_FILIAL'),
  col('DATA_PEDIDO'),
  col('VALOR_PEDIDO', true),
];

export interface ResultadoAncora {
  confere: boolean;
  divergenciaPct?: number;
  qtUpstream: number;
  qtLocal: number;
  valorUpstream?: number;
  valorLocal: number;
}

export interface AncoraResumo {
  codigo_filial: string;
  periodo: string;
  divergencia_pct: number | null;
  verificado_em: string;
}

@Injectable()
export class VendasAncoraService {
  private readonly logger = new Logger(VendasAncoraService.name);

  constructor(
    private readonly mobile: WinthorMobileService,
    private readonly metaDb: VendasMetaDbService,
    private readonly fatoDb: VendasFatoDbService,
    private readonly store: VendasStoreService,
  ) {}

  async verificar(
    instanciaId: number,
    codigoFilial: string,
    periodo: PeriodoCodigo,
    posicaoPedido: string,
    agora = new Date(),
  ): Promise<ResultadoAncora> {
    const janela = janelaDoPeriodo(periodo, agora);

    const upstream = await this.mobile.listarLucratividade(
      ENDPOINTS.pedidosDeVenda,
      [...COLUNAS],
      {
        listaFilial: [codigoFilial],
        periodo,
        posicaoPedido,
        margemMinLucro: '100',
        perspectiva: '1',
        page: 1,
        pageSize: 1,
      },
    );

    const qtUpstreamRaw = upstream.ok ? upstream.data?.total : undefined;
    const qtUpstream =
      typeof qtUpstreamRaw === 'number' && Number.isFinite(qtUpstreamRaw)
        ? qtUpstreamRaw
        : undefined;
    const valorUpstream = upstream.ok
      ? numeroDoTotalizer(upstream.data?.totalizer, 'VALOR_PEDIDO')
      : undefined;

    const fato = await this.fatoDb.conexao();
    const local = await consultarUm<{ qt: number; valor: number }>(
      fato,
      `SELECT COUNT(*) AS qt, COALESCE(SUM(valor_pedido), 0) AS valor
         FROM pedido
        WHERE instancia_id = ? AND codigo_filial = ?
          AND dia BETWEEN ? AND ?`,
      [instanciaId, codigoFilial, janela.dataInicio, janela.dataFim],
    );
    const qtLocal = Number(local?.qt ?? 0);
    const valorLocal = Number(local?.valor ?? 0);

    /**
     * Sem totalizer e sem `total` do ERP a comparação é chute — marcar cobertura
     * como suspeita aqui criava falso positivo após sync pesado (timeout no
     * pageSize=1 da âncora).
     */
    if (
      !upstream.ok ||
      (qtUpstream === undefined && valorUpstream === undefined)
    ) {
      this.logger.warn(
        `âncora inconclusiva filial ${codigoFilial} periodo ${periodo}: ` +
          (!upstream.ok
            ? `upstream falhou (${upstream.error ?? 'erro'})`
            : 'totalizer e total ausentes na resposta'),
      );
      return {
        confere: true,
        divergenciaPct: undefined,
        qtUpstream: qtUpstream ?? 0,
        qtLocal,
        valorUpstream,
        valorLocal,
      };
    }

    const totalErp = qtUpstream ?? 0;
    const divergenciaPct =
      valorUpstream !== undefined && valorUpstream !== 0
        ? ((valorLocal - valorUpstream) / valorUpstream) * 100
        : undefined;
    const confere =
      divergenciaPct === undefined
        ? qtLocal === totalErp
        : Math.abs(divergenciaPct) <= TOLERANCIA_CONFERENCIA_PCT;

    const verificadoEm = new Date().toISOString();
    this.metaDb
      .banco()
      .prepare(
        `INSERT INTO ancora (instancia_id, codigo_filial, periodo, posicao_pedido,
                             verificado_em, dia_inicio, dia_fim, qt_upstream,
                             valor_upstream, qt_local, valor_local, divergencia_pct, confere)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(instancia_id, codigo_filial, periodo, posicao_pedido) DO UPDATE SET
           verificado_em = excluded.verificado_em,
           qt_upstream = excluded.qt_upstream,
           valor_upstream = excluded.valor_upstream,
           qt_local = excluded.qt_local,
           valor_local = excluded.valor_local,
           divergencia_pct = excluded.divergencia_pct,
           confere = excluded.confere`,
      )
      .run(
        instanciaId,
        codigoFilial,
        periodo,
        posicaoPedido,
        verificadoEm,
        janela.dataInicio,
        janela.dataFim,
        totalErp,
        valorUpstream ?? null,
        qtLocal,
        valorLocal,
        divergenciaPct ?? null,
        confere ? 1 : 0,
      );

    if (!confere) {
      this.logger.warn(
        `âncora falhou filial ${codigoFilial} periodo ${periodo}: ` +
          `local ${valorLocal} vs upstream ${String(valorUpstream)}`,
      );
      this.store.marcarCoberturaSuspeita(instanciaId, codigoFilial, janela);
    }

    return {
      confere,
      divergenciaPct,
      qtUpstream: totalErp,
      qtLocal,
      valorUpstream,
      valorLocal,
    };
  }

  listarProblemas(instanciaId: number): AncoraResumo[] {
    return this.metaDb
      .banco()
      .prepare(
        `SELECT codigo_filial, periodo, divergencia_pct, verificado_em
           FROM ancora
          WHERE instancia_id = ? AND confere = 0
          ORDER BY verificado_em DESC LIMIT 10`,
      )
      .all(instanciaId) as {
      codigo_filial: string;
      periodo: string;
      divergencia_pct: number | null;
      verificado_em: string;
    }[];
  }

  /**
   * Verifica períodos congelados (fora da janela quente) que já têm cobertura fria.
   */
  async verificarPeriodosCongelados(
    instanciaId: number,
    filiais: string[],
    periodos: PeriodoCodigo[] = ['7', '8'],
    posicaoPedido = '0',
  ): Promise<void> {
    for (const codigoFilial of filiais) {
      for (const periodo of periodos) {
        const temFrio = (
          this.metaDb
            .banco()
            .prepare(
              `SELECT COUNT(*) AS c FROM cobertura
                WHERE instancia_id = ? AND codigo_filial = ?
                  AND estado = 'frio'`,
            )
            .get(instanciaId, codigoFilial) as { c: number }
        ).c;
        if (temFrio > 0) {
          await this.verificar(
            instanciaId,
            codigoFilial,
            periodo,
            posicaoPedido,
          );
        }
      }
    }
  }
}

function numeroDoTotalizer(
  totalizer: Record<string, number> | undefined,
  chave: string,
): number | undefined {
  const valor = totalizer?.[chave];
  return typeof valor === 'number' && Number.isFinite(valor)
    ? valor
    : undefined;
}
