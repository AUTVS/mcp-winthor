import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  INGESTAO_PAGE_SIZE,
  INGESTAO_PAGE_SIZE_MIN,
  INGESTAO_PAUSA_MS,
  INGESTAO_PAUSA_OCUPADO_MS,
  INGESTAO_RETRY_MAX,
} from '../config/limits';
import { WinthorApiResult, WinthorApiService } from '../winthor/winthor-api.service';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import {
  extrairItensEstoque,
  extrairTotalEstoque,
} from './estoque-resposta';
import { EstoqueMetaDbService } from './estoque-meta-db.service';
import { EstoqueStoreService } from './estoque-store.service';

const ESTOQUE_INGESTAO_AUTO =
  (process.env.WTA_ESTOQUE_INGESTAO_AUTO ??
    process.env.WTA_INGESTAO_AUTO ??
    '1') !== '0';
const ESTOQUE_INGESTAO_INTERVALO_MS = Number(
  process.env.WTA_ESTOQUE_INGESTAO_INTERVALO_MS ??
    process.env.WTA_INGESTAO_INTERVALO_MS ??
    30 * 60_000,
);
const ESTOQUE_INGESTAO_VALIDADE_MS = Number(
  process.env.WTA_ESTOQUE_INGESTAO_VALIDADE_MS ?? 4 * 60 * 60_000,
);

export type EscopoSyncEstoque = 'completo' | 'atualizacao';

export interface StatusIngestaoEstoque {
  rodando: boolean;
  escopo?: EscopoSyncEstoque;
  iniciadoEm?: string;
  filiaisTotal: number;
  filiaisConcluidas: number;
  filialAtual?: string;
  paginas: number;
  linhas: number;
  erros: string[];
  cancelado: boolean;
  trabalho: LinhaTrabalhoEstoque[];
}

export type NivelTrabalhoEstoque = 'info' | 'warn' | 'error' | 'ok';

export interface LinhaTrabalhoEstoque {
  em: string;
  nivel: NivelTrabalhoEstoque;
  mensagem: string;
}

const MAX_LINHAS_TRABALHO = 80;

function vazio(): StatusIngestaoEstoque {
  return {
    rodando: false,
    filiaisTotal: 0,
    filiaisConcluidas: 0,
    paginas: 0,
    linhas: 0,
    erros: [],
    cancelado: false,
    trabalho: [],
  };
}

function ePayloadGrande(erro: string): boolean {
  return /passou de|interrompida|bytes/i.test(erro);
}

function eTransitorio(erro: string): boolean {
  return /timeout|fetch failed|network|aborted|502|503|504/i.test(erro);
}

@Injectable()
export class EstoqueIngestaoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EstoqueIngestaoService.name);
  private timer?: NodeJS.Timeout;
  private estado: StatusIngestaoEstoque = vazio();
  private cancelar_ = false;
  private ocupadoAte = 0;
  private historicoTrabalho: LinhaTrabalhoEstoque[] = [];
  private fila: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: WinthorApiService,
    private readonly mobile: WinthorMobileService,
    private readonly store: EstoqueStoreService,
    private readonly metaDb: EstoqueMetaDbService,
  ) {}

  onModuleInit(): void {
    if (this.metaDb.instanciaId() !== null) {
      this.store.expirarLotesOrfaos();
    }

    if (!ESTOQUE_INGESTAO_AUTO) {
      this.logger.log(
        'sincronização automática de estoque desligada (WTA_ESTOQUE_INGESTAO_AUTO=0)',
      );
      return;
    }

    this.timer = setInterval(
      () => this.verificarVencimento(),
      ESTOQUE_INGESTAO_INTERVALO_MS,
    );
    this.timer.unref();
    setTimeout(() => this.verificarVencimento(), 8_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.cancelar_ = true;
  }

  private verificarVencimento(): void {
    if (this.estado.rodando) return;

    const instanciaId = this.metaDb.instanciaId();
    if (instanciaId === null) return;

    if (!this.store.temCobertura(instanciaId)) {
      this.logger.log('base local de estoque vazia: iniciando carga completa.');
      this.sincronizar({ escopo: 'completo' });
      return;
    }

    const maisAntigo = this.store.idadeDaCobertura(instanciaId);
    const vencido =
      maisAntigo === null ||
      Date.now() - new Date(maisAntigo).getTime() > ESTOQUE_INGESTAO_VALIDADE_MS;

    if (vencido) {
      this.logger.log(
        `cobertura de estoque vencida (mais antigo: ${maisAntigo ?? 'nenhum'}): atualizando.`,
      );
      this.sincronizar({ escopo: 'atualizacao' });
    }
  }

  status(): StatusIngestaoEstoque {
    return {
      ...this.estado,
      erros: [...this.estado.erros],
      trabalho: [...this.historicoTrabalho],
    };
  }

  cancelar(): void {
    this.cancelar_ = true;
    this.registrarTrabalho('warn', 'cancelamento solicitado — para na próxima página');
  }

  marcarOcupado(): void {
    this.ocupadoAte = Date.now() + 10_000;
  }

  sincronizar(opts: {
    escopo: EscopoSyncEstoque;
    filiais?: string[];
  }): { aceito: boolean; motivo?: string } {
    if (this.estado.rodando) {
      return { aceito: false, motivo: 'já existe uma sincronização de estoque em curso' };
    }
    if (this.metaDb.instanciaId() === null) {
      return { aceito: false, motivo: 'servidor ainda não configurado' };
    }

    this.fila = this.fila.then(() =>
      this.executar(opts).catch((err) => {
        const msg = String(err);
        this.logger.error(`sincronização de estoque falhou: ${msg}`);
        this.registrarTrabalho('error', `sincronização abortou: ${msg}`);
        this.estado.erros.push(msg);
        this.estado.rodando = false;
      }),
    );
    return { aceito: true };
  }

  private async executar(opts: {
    escopo: EscopoSyncEstoque;
    filiais?: string[];
  }): Promise<void> {
    const instanciaId = this.metaDb.instanciaId();
    if (instanciaId === null) return;

    const filiais = opts.filiais?.length
      ? opts.filiais.map(String)
      : await this.mobile.filiaisPadrao();

    if (!filiais.length) {
      this.estado = { ...vazio(), erros: ['nenhuma filial visível ao usuário'] };
      this.registrarTrabalho('error', 'nenhuma filial visível ao usuário');
      return;
    }

    if (!opts.filiais?.length) {
      this.store.registrarFiliaisAlvo(instanciaId, filiais);
    }

    this.cancelar_ = false;
    this.historicoTrabalho = [];
    this.estado = {
      rodando: true,
      escopo: opts.escopo,
      iniciadoEm: new Date().toISOString(),
      filiaisTotal: filiais.length,
      filiaisConcluidas: 0,
      paginas: 0,
      linhas: 0,
      erros: [],
      cancelado: false,
      trabalho: [],
    };

    this.registrarTrabalho(
      'info',
      `início estoque: ${opts.escopo} · ${filiais.length} filial(is)`,
    );

    try {
      for (const codigoFilial of filiais) {
        if (this.cancelar_) {
          this.estado.cancelado = true;
          break;
        }
        this.estado.filialAtual = codigoFilial;
        this.registrarTrabalho(
          'info',
          `filial ${codigoFilial}: ${this.estado.filiaisConcluidas + 1}/${filiais.length}`,
        );
        await this.executarFilial(instanciaId, codigoFilial);
        this.estado.filiaisConcluidas++;
      }

      if (this.estado.cancelado) {
        this.registrarTrabalho('warn', 'sincronização de estoque cancelada');
      } else if (this.estado.erros.length) {
        this.registrarTrabalho(
          'warn',
          `sincronização encerrada com ${this.estado.erros.length} aviso(s)`,
        );
      } else {
        this.registrarTrabalho(
          'ok',
          `sincronização concluída · ${this.estado.linhas.toLocaleString('pt-BR')} produto(s) gravados`,
        );
      }
    } finally {
      this.estado.rodando = false;
      this.estado.filialAtual = undefined;
      this.estado.trabalho = [...this.historicoTrabalho];
    }
  }

  private async executarFilial(
    instanciaId: number,
    codigoFilial: string,
  ): Promise<void> {
    const loteId = this.store.abrirLote(instanciaId, codigoFilial);
    const vistos = new Set<string>();
    let paginas = 0;
    let totalUpstream: number | undefined;
    let completa = false;
    let motivo: string | undefined;
    let pageSize = INGESTAO_PAGE_SIZE;

    for (let page = 1; ; page++) {
      if (this.cancelar_) {
        motivo = 'cancelado pelo usuário';
        break;
      }

      const r = await this.buscarPaginaComRetry(codigoFilial, page, pageSize);
      if (!r.ok) {
        const msg = r.error ?? 'falha na chamada ao WinThor';
        await this.store.fecharLote(loteId, {
          estado: 'falhou',
          paginas,
          motivo: msg,
        });
        this.registrarTrabalho('error', `filial ${codigoFilial}: ${msg}`);
        this.estado.erros.push(`filial ${codigoFilial}: ${msg}`);
        return;
      }
      pageSize = r.pageSize;

      paginas++;
      this.estado.paginas++;
      const itens = extrairItensEstoque(r.data).map((i) =>
        i as Record<string, unknown>,
      );
      totalUpstream = extrairTotalEstoque(r.data) ?? totalUpstream;

      if (itens.length === 0) {
        completa = true;
        break;
      }

      const antes = vistos.size;
      for (const item of itens) {
        const codigo =
          item.produtoId ?? item.codProd ?? item.codigoProduto ?? item.id;
        vistos.add(
          typeof codigo === 'string' || typeof codigo === 'number'
            ? String(codigo)
            : JSON.stringify(item),
        );
      }
      if (vistos.size === antes) {
        motivo = 'upstream repetiu a página; paginação não avançou';
        break;
      }

      const gravado = await this.store.gravarPagina(loteId, itens, page + 1);
      this.estado.linhas += gravado.gravados;

      if (totalUpstream !== undefined && vistos.size >= totalUpstream) {
        completa = true;
        break;
      }
      if (itens.length < pageSize) {
        if (totalUpstream !== undefined && vistos.size < totalUpstream) {
          motivo = `página curta com ${totalUpstream} disponíveis no upstream`;
        } else {
          completa = true;
        }
        break;
      }

      await this.pausar();
    }

    const fechamento = await this.store.fecharLote(loteId, {
      estado: completa ? 'completo' : 'parcial',
      paginas,
      totalUpstream,
      motivo,
    });

    this.registrarTrabalho(
      fechamento.estado === 'completo' ? 'ok' : 'warn',
      `filial ${codigoFilial}: ${fechamento.estado} · ${paginas} página(s) · ${fechamento.linhas} produto(s)`,
    );

    if (fechamento.estado !== 'completo') {
      this.estado.erros.push(
        `filial ${codigoFilial}: ${motivo ?? 'varredura incompleta'}`,
      );
    }
  }

  private async buscarPaginaComRetry(
    codigoFilial: string,
    page: number,
    pageSizeInicial: number,
  ): Promise<WinthorApiResult & { pageSize: number }> {
    let pageSize = pageSizeInicial;
    let tentativasTransitorias = 0;

    for (;;) {
      const r = await this.api.buscarEstoquePorFilial({
        codigoFilial,
        page,
        pageSize,
      });

      if (r.ok) return { ...r, pageSize };

      const erro = r.error ?? '';
      if (ePayloadGrande(erro) && pageSize > INGESTAO_PAGE_SIZE_MIN) {
        pageSize = Math.max(
          INGESTAO_PAGE_SIZE_MIN,
          Math.floor(pageSize / 2),
        );
        continue;
      }

      if (eTransitorio(erro) && tentativasTransitorias < INGESTAO_RETRY_MAX) {
        tentativasTransitorias++;
        await this.esperarRetry(1_000 * tentativasTransitorias);
        continue;
      }

      return { ...r, pageSize };
    }
  }

  private async pausar(): Promise<void> {
    const ms =
      Date.now() < this.ocupadoAte
        ? INGESTAO_PAUSA_OCUPADO_MS
        : INGESTAO_PAUSA_MS;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async esperarRetry(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private registrarTrabalho(
    nivel: NivelTrabalhoEstoque,
    mensagem: string,
  ): void {
    const linha: LinhaTrabalhoEstoque = {
      em: new Date().toISOString(),
      nivel,
      mensagem,
    };
    this.historicoTrabalho.push(linha);
    if (this.historicoTrabalho.length > MAX_LINHAS_TRABALHO) {
      this.historicoTrabalho.shift();
    }
    this.estado.trabalho = [...this.historicoTrabalho];
  }

  /** Só para os testes: encurta as pausas sem esperar segundos de verdade. */
  static semPausa(servico: EstoqueIngestaoService): void {
    const noop = () => Promise.resolve();
    (servico as unknown as { pausar: () => Promise<void> }).pausar = noop;
    (servico as unknown as { esperarRetry: () => Promise<void> }).esperarRetry =
      noop;
  }
}
