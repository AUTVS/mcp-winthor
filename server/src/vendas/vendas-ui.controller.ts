import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WtConfigService } from '../config/wt-config.service';
import type { PeriodoCodigo } from '../winthor/winthor-mobile.types';
import {
  coberturaPorMes,
  filiaisComCobertura,
  medirCobertura,
} from '../vendas/cobertura';
import {
  Dia,
  diaNoErp,
  diasEntre,
  janelaFria,
  janelaHistorico,
  janelaQuente,
  type Janela,
} from '../vendas/periodo-janela';
import { VendasFatoDbService } from '../vendas/vendas-fato-db.service';
import {
  EscopoSync,
  VendasIngestaoService,
} from '../vendas/vendas-ingestao.service';
import { VendasMetaDbService } from '../vendas/vendas-meta-db.service';
import { VendasStoreService } from '../vendas/vendas-store.service';

/**
 * As duas zonas de cache, uma por botão do painel.
 *
 * Antes o painel mostrava os quatro períodos do enum ('3','4','7','8') lado a lado.
 * Mas '3' ⊂ '7' e '4' ⊂ '7': os cards contavam os mesmos dias duas vezes, e
 * "Ano atual" nunca ficava saudável mesmo com a atualização diária escrevendo nele.
 * Um card que o usuário não consegue consertar é ruído; um card por botão é contrato.
 *
 * A zona histórica é o COMPLEMENTO da quente, e não a janela de '7'+'8'. O botão
 * histórico de fato dispara '7'+'8', que reescrevem a zona quente também — a zona é
 * unidade de LEITURA, não de escrita. Recortar assim é o que as torna disjuntas.
 */
const ZONAS: {
  escopo: EscopoSync;
  rotulo: string;
  periodos: PeriodoCodigo[];
  janela: (agora: Date) => Janela;
}[] = [
  {
    escopo: 'atualizacao',
    rotulo: 'Atualização (mês atual e anterior)',
    periodos: ['3', '4'],
    janela: janelaQuente,
  },
  {
    escopo: 'historico',
    rotulo: 'Histórico (até o mês retrasado)',
    periodos: ['7', '8'],
    janela: janelaFria,
  },
];

/**
 * Quantos dias faltantes viajam no JSON.
 *
 * Zona fria vazia tem ~400 dias faltando; o painel faz poll de 1,5 s durante a
 * sincronização e não precisa da lista inteira para dizer o que falta.
 */
const MAX_FALTANTES = 10;

export type EstadoZona = 'completo' | 'parcial' | 'vazio';

export interface ZonaCache {
  /** Casa 1:1 com o botão que preenche a zona e com o corpo do POST. */
  escopo: EscopoSync;
  rotulo: string;
  /** Períodos do enum que o botão dispara — rastreabilidade, não UI. */
  periodos: PeriodoCodigo[];
  estado: EstadoZona;
  dataInicio: Dia;
  dataFim: Dia;
  diasEsperados: number;
  /** Dias cobertos em TODAS as filiais esperadas — o que a consulta exige. */
  diasCobertos: number;
  paresEsperados: number;
  paresCobertos: number;
  diasFaltantes: Dia[];
  faltantesTotal: number;
  atualizadoEm: string | null;
  suspeitos: number;
}

export interface MesCache {
  /** `YYYY-MM`. */
  mes: string;
  zona: EscopoSync;
  diasEsperados: number;
  diasCobertos: number;
  filiais: number;
  pedidos: number;
  atualizadoEm: string | null;
}

export interface FiliaisStatus {
  /** Conjunto contra o qual a cobertura é medida. */
  esperadas: string[];
  /** Subconjunto que já tem alguma cobertura no horizonte. */
  cobertas: string[];
  /** `'sync'` = registrado pela última varredura padrão; `'cobertura'` = inferido. */
  fonte: 'sync' | 'cobertura';
}

@Controller('vendas')
export class VendasUiController {
  constructor(
    private readonly configService: WtConfigService,
    private readonly metaDb: VendasMetaDbService,
    private readonly fatoDb: VendasFatoDbService,
    private readonly store: VendasStoreService,
    private readonly ingestao: VendasIngestaoService,
  ) {}

  /**
   * Ponto único de leitura do relógio.
   *
   * As funções de janela já aceitam `agora`; o que faltava era o endpoint ter um lugar
   * só onde o instante entra, para o teste conseguir congelar o dia sem mexer em
   * timers globais (que atrapalhariam o DuckDB).
   */
  protected agora(): Date {
    return new Date();
  }

  @Get('status')
  async status(@Res() res: Response) {
    if (!this.configService.isConfigured()) {
      return res.status(503).json({
        ok: false,
        configurado: false,
        message: 'wt.ai ainda não está configurado.',
      });
    }

    const agora = this.agora();
    const hoje = diaNoErp(agora);
    const instanciaId = this.metaDb.instanciaId();

    if (instanciaId === null) {
      return res.json({
        ok: true,
        configurado: true,
        hoje,
        pedidos: 0,
        filiais: { esperadas: [], cobertas: [], fonte: 'cobertura' },
        zonas: ZONAS.map((z) => this.zonaVazia(z, agora)),
        meses: [],
        sincronizacao: this.ingestao.status(),
      });
    }

    const db = this.metaDb.banco();
    const { filiais, fonte } = this.store.filiaisEsperadas(instanciaId);
    const horizonte = janelaHistorico(agora);
    const quente = janelaQuente(agora);

    const zonas = ZONAS.map((z) =>
      this.avaliarZona(instanciaId, z, filiais, agora),
    );

    const meses: MesCache[] = coberturaPorMes(db, {
      instanciaId,
      janela: horizonte,
      filiais,
    }).map((m) => ({
      ...m,
      // O mês pertence à zona quente se qualquer dia dele estiver nela.
      zona:
        m.mes >= quente.dataInicio.slice(0, 7) ? 'atualizacao' : 'historico',
    }));

    const filiaisStatus: FiliaisStatus = {
      esperadas: filiais,
      cobertas: filiaisComCobertura(db, instanciaId, horizonte),
      fonte,
    };

    return res.json({
      ok: true,
      configurado: true,
      hoje,
      pedidos: await this.fatoDb.contarPedidos(instanciaId),
      filiais: filiaisStatus,
      zonas,
      meses,
      sincronizacao: this.ingestao.status(),
    });
  }

  @Post('sincronizar')
  sincronizar(
    @Body()
    body: {
      escopo?: EscopoSync;
      filiais?: string[] | string | number;
      cancelar?: boolean;
    },
    @Res() res: Response,
  ) {
    if (!this.configService.isConfigured()) {
      return res.status(503).json({
        ok: false,
        message: 'wt.ai ainda não está configurado.',
      });
    }

    if (body.cancelar) {
      this.ingestao.cancelar();
      return res.json({
        ok: true,
        cancelado: true,
        status: this.ingestao.status(),
        message: 'Cancelamento solicitado. A varredura para na próxima página.',
      });
    }

    const escopo: EscopoSync =
      body.escopo === 'historico' ? 'historico' : 'atualizacao';
    const filiais = normalizarFiliais(body.filiais);

    const r = this.ingestao.sincronizar({
      escopo,
      ...(filiais.length ? { filiais } : {}),
    });

    return res.status(r.aceito ? 200 : 409).json({
      ok: r.aceito,
      escopo,
      // Ecoado porque sync dirigido NÃO redefine a expectativa da base: o usuário
      // precisa ver que pediu um subconjunto.
      filiais,
      ...(r.motivo ? { motivo: r.motivo } : {}),
      status: this.ingestao.status(),
      message: r.aceito
        ? escopo === 'historico'
          ? 'Sincronização histórica iniciada (ano atual e anterior).'
          : 'Atualização iniciada (mês atual e anterior).'
        : (r.motivo ?? 'Não foi possível iniciar a sincronização.'),
    });
  }

  /** Sem instância ainda não há banco a consultar — só a forma da janela. */
  private zonaVazia(z: (typeof ZONAS)[number], agora: Date): ZonaCache {
    const janela = z.janela(agora);
    const dias = diasEntre(janela.dataInicio, janela.dataFim).length;

    return {
      escopo: z.escopo,
      rotulo: z.rotulo,
      periodos: z.periodos,
      estado: 'vazio',
      dataInicio: janela.dataInicio,
      dataFim: janela.dataFim,
      diasEsperados: dias,
      diasCobertos: 0,
      paresEsperados: 0,
      paresCobertos: 0,
      diasFaltantes: [],
      faltantesTotal: dias,
      atualizadoEm: null,
      suspeitos: 0,
    };
  }

  private avaliarZona(
    instanciaId: number,
    z: (typeof ZONAS)[number],
    filiais: string[],
    agora: Date,
  ): ZonaCache {
    const janela = z.janela(agora);
    const r = medirCobertura(this.metaDb.banco(), {
      instanciaId,
      janela,
      filiais,
    });

    // `completo` exige filial esperada: sem alvo não há afirmação, só ignorância.
    // É exatamente aqui que o endpoint antigo dizia "Cacheado" com uma filial de cinco.
    const estado: EstadoZona = r.completa
      ? 'completo'
      : r.paresCobertos > 0
        ? 'parcial'
        : 'vazio';

    return {
      escopo: z.escopo,
      rotulo: z.rotulo,
      periodos: z.periodos,
      estado,
      dataInicio: janela.dataInicio,
      dataFim: janela.dataFim,
      diasEsperados: r.dias,
      diasCobertos: r.diasCompletos,
      paresEsperados: r.paresEsperados,
      paresCobertos: r.paresCobertos,
      diasFaltantes: r.faltantes.slice(0, MAX_FALTANTES),
      faltantesTotal: r.faltantes.length,
      atualizadoEm: r.atualizadoEm,
      suspeitos: r.suspeitos,
    };
  }
}

/**
 * Paridade com `wt_vendas_sincronizar`: aceita escalar e coage para string, porque
 * código de filial chega como número em JSON com frequência.
 */
function normalizarFiliais(valor: unknown): string[] {
  if (valor === undefined || valor === null) return [];
  const bruto = Array.isArray(valor) ? valor : [valor];
  return bruto
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((v) => v.length > 0);
}
