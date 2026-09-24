import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  INGESTAO_AUTO,
  INGESTAO_INTERVALO_MS,
  INGESTAO_PAGE_SIZE,
  INGESTAO_PAGE_SIZE_MIN,
  INGESTAO_PAUSA_MS,
  INGESTAO_PAUSA_OCUPADO_MS,
  INGESTAO_RETRY_MAX,
  INGESTAO_VALIDADE_MS,
  RETENCAO_ANOS,
} from '../config/limits';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import {
  col,
  ColunaGrid,
  ENDPOINTS,
  GridResult,
  PeriodoCodigo,
} from '../winthor/winthor-mobile.types';
import { WinthorApiResult } from '../winthor/winthor-api.service';
import { diaNoErp, janelaDoPeriodo, Janela } from './periodo-janela';
import { VendasAncoraService } from './vendas-ancora.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';

/**
 * Ingestão da base local de vendas.
 *
 * Lê `listarPedidosDeVenda` filial a filial e grava página a página. A unidade é
 * (filial × período) porque é o que dá retomada barata, conferência com alvo
 * exato e varredura de sobra segura — ver o cabeçalho de `VendasStoreService`.
 */

/**
 * Colunas pedidas. O backend ignora `data.list` no SELECT e devolve o pedido
 * completo de qualquer jeito (§6.8); a lista serve para marcar o que entra no
 * `totalizer`, que é o alvo da conferência.
 */
const COLUNAS: ColunaGrid[] = [
  col('NUMERO_PEDIDO'),
  col('CODIGO_FILIAL'),
  col('DATA_PEDIDO'),
  col('POSICAO_PEDIDO'),
  col('CODIGO_CLIENTE'),
  col('VALOR_PEDIDO', true),
  col('CUSTO_FINANCEIRO', true),
];

/**
 * Ingestão varre **todas as posições** (`'0'`), não só Faturado.
 *
 * Uma varredura serve a qualquer recorte de posição depois, em vez de cinco. O
 * rótulo de cada linha é gravado como veio e o mapa código→rótulo é aprendido do
 * ERP (`aprenderPosicoes`) — o contrato só documenta os códigos do filtro, e só
 * `'FATURADO'` foi observado numa resposta real.
 */
const POSICAO_INGESTAO = '0';
const MARGEM_PADRAO = '100';

/** Histórico completo alcançável pelo enum: ano atual e ano anterior. */
const PERIODOS_HISTORICO: PeriodoCodigo[] = ['7', '8'];
/**
 * Janela que o enum ainda refaz de forma exata. `'4'` é o que congela o mês
 * passado: um pedido do dia 28 pode virar FATURADO no dia 2 do mês seguinte.
 */
const PERIODOS_ATUALIZACAO: PeriodoCodigo[] = ['3', '4'];

export type EscopoSync = 'historico' | 'atualizacao';

export interface ItemPlano {
  codigoFilial: string;
  periodo: PeriodoCodigo;
  janela: Janela;
}

export interface StatusIngestao {
  rodando: boolean;
  escopo?: EscopoSync;
  iniciadoEm?: string;
  itensTotal: number;
  itensConcluidos: number;
  itemAtual?: string;
  paginas: number;
  linhas: number;
  erros: string[];
  cancelado: boolean;
  /** Últimas linhas do trabalho em segundo plano (para UI e debug). */
  trabalho: LinhaTrabalho[];
}

export type NivelTrabalho = 'info' | 'warn' | 'error' | 'ok';

export interface LinhaTrabalho {
  em: string;
  nivel: NivelTrabalho;
  mensagem: string;
}

const MAX_LINHAS_TRABALHO = 80;

@Injectable()
export class VendasIngestaoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendasIngestaoService.name);
  private timer?: NodeJS.Timeout;
  private estado: StatusIngestao = vazio();
  private cancelar_ = false;
  private ocupadoAte = 0;
  /** Linhas recentes do trabalho de sincronização (ring buffer). */
  private historicoTrabalho: LinhaTrabalho[] = [];
  /** Serializa: nunca duas varreduras concorrentes contra o mesmo ERP. */
  private fila: Promise<void> = Promise.resolve();

  constructor(
    private readonly mobile: WinthorMobileService,
    private readonly store: VendasStoreService,
    private readonly dbService: VendasMetaDbService,
    private readonly ancora: VendasAncoraService,
  ) {}

  /**
   * Liga a manutenção automática da base.
   *
   * Verifica periodicamente se a atualização **venceu**, em vez de disparar em
   * hora fixa: num notebook fechado às 3h um gatilho horário nunca roda, e
   * comparar contra a idade da cobertura dispara na primeira vez que a máquina
   * acorda. `unref` para o timer nunca segurar o encerramento do processo.
   */
  onModuleInit(): void {
    // Antes da guarda de INGESTAO_AUTO: lote órfão precisa ser fechado mesmo com
    // a sincronização automática desligada, senão fica preso até alguém varrer.
    if (this.dbService.instanciaId() !== null) {
      this.store.expirarLotesOrfaos();
    }

    if (!INGESTAO_AUTO) {
      this.logger.log(
        'sincronização automática desligada (WTA_INGESTAO_AUTO=0)',
      );
      return;
    }
    this.timer = setInterval(
      () => this.verificarVencimento(),
      INGESTAO_INTERVALO_MS,
    );
    this.timer.unref();
    // Uma verificação logo no start, para o primeiro backfill não esperar o
    // primeiro tique — mas fora do caminho do boot, que não pode travar.
    setTimeout(() => this.verificarVencimento(), 5_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.cancelar_ = true;
  }

  /**
   * Dispara o que estiver vencido. Base vazia pede o histórico inteiro; base
   * carregada pede só a janela quente, que é o que o enum ainda refaz exato.
   */
  private verificarVencimento(): void {
    if (this.estado.rodando) return;

    const instanciaId = this.dbService.instanciaId();
    if (instanciaId === null) return; // ainda não configurado

    if (!this.store.temCobertura(instanciaId)) {
      this.logger.log('base local vazia: iniciando carga do histórico.');
      this.sincronizar({ escopo: 'historico' });
      return;
    }

    const maisAntigo = this.store.idadeDaJanelaQuente(instanciaId);
    const vencido =
      maisAntigo === null ||
      Date.now() - new Date(maisAntigo).getTime() > INGESTAO_VALIDADE_MS;

    if (vencido) {
      this.logger.log(
        `janela quente vencida (mais antigo: ${maisAntigo ?? 'nenhum'}): atualizando.`,
      );
      this.sincronizar({ escopo: 'atualizacao' });
    }
  }

  status(): StatusIngestao {
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

  /**
   * Avisa que há tool call em voo, para a ingestão ceder a vez.
   *
   * O backfill leva perto de duas horas; o usuário não pode esperar atrás dele.
   * A pausa entre páginas sobe enquanto a janela de ocupado estiver aberta.
   */
  marcarOcupado(): void {
    this.ocupadoAte = Date.now() + 10_000;
  }

  /**
   * Enfileira uma sincronização. Volta na hora — o trabalho segue em segundo
   * plano e é acompanhado por `status()`.
   */
  sincronizar(opts: { escopo: EscopoSync; filiais?: string[] }): {
    aceito: boolean;
    motivo?: string;
  } {
    if (this.estado.rodando) {
      return { aceito: false, motivo: 'já existe uma sincronização em curso' };
    }
    if (this.dbService.instanciaId() === null) {
      return { aceito: false, motivo: 'servidor ainda não configurado' };
    }

    this.fila = this.fila.then(() =>
      this.executar(opts).catch((err) => {
        const msg = String(err);
        this.logger.error(`sincronização falhou: ${msg}`);
        this.registrarTrabalho('error', `sincronização abortou: ${msg}`);
        this.estado.erros.push(msg);
        this.estado.rodando = false;
      }),
    );
    return { aceito: true };
  }

  private async executar(opts: {
    escopo: EscopoSync;
    filiais?: string[];
  }): Promise<void> {
    const instanciaId = this.dbService.instanciaId();
    if (instanciaId === null) return;

    const filiais = opts.filiais?.length
      ? opts.filiais.map(String)
      : await this.mobile.filiaisPadrao();

    if (!filiais.length) {
      this.estado = {
        ...vazio(),
        erros: ['nenhuma filial visível ao usuário'],
      };
      this.registrarTrabalho('error', 'nenhuma filial visível ao usuário');
      return;
    }

    const periodos =
      opts.escopo === 'historico' ? PERIODOS_HISTORICO : PERIODOS_ATUALIZACAO;
    const agora = new Date();

    // Só o conjunto PADRÃO define a expectativa da base. Um sync dirigido a uma
    // filial não pode encolher a expectativa da base inteira — senão pedir "só a
    // filial 1" faria toda a cobertura parecer completa no minuto seguinte.
    if (!opts.filiais?.length) {
      this.store.registrarFiliaisAlvo(instanciaId, filiais, agora);
    }

    const plano: ItemPlano[] = [];
    for (const periodo of periodos) {
      for (const codigoFilial of filiais) {
        plano.push({
          codigoFilial,
          periodo,
          janela: janelaDoPeriodo(periodo, agora),
        });
      }
    }

    this.cancelar_ = false;
    this.historicoTrabalho = [];
    this.estado = {
      rodando: true,
      escopo: opts.escopo,
      iniciadoEm: agora.toISOString(),
      itensTotal: plano.length,
      itensConcluidos: 0,
      paginas: 0,
      linhas: 0,
      erros: [],
      cancelado: false,
      trabalho: [],
    };

    this.registrarTrabalho(
      'info',
      `início: ${opts.escopo} · ${plano.length} lote(s) · ${filiais.length} filial(is)` +
        (opts.filiais?.length
          ? ` (dirigido: ${opts.filiais.join(', ')})`
          : ''),
    );

    try {
      this.registrarTrabalho('info', 'aprendendo mapa de posição do ERP…');
      await this.aprenderPosicoes(instanciaId, filiais[0]);
      if (!(await this.verificarDerivacaoDeDia(instanciaId, filiais[0]))) {
        const msg =
          'a derivação do dia não se confirmou neste ERP; nenhuma cobertura será publicada';
        this.estado.erros.push(msg);
        this.registrarTrabalho('error', msg);
        return;
      }
      this.registrarTrabalho('ok', 'derivação do dia confirmada');

      for (const item of plano) {
        if (this.cancelar_) {
          this.estado.cancelado = true;
          break;
        }
        this.estado.itemAtual = `filial ${item.codigoFilial}, periodo ${item.periodo}`;
        this.registrarTrabalho(
          'info',
          `lote ${this.estado.itensConcluidos + 1}/${plano.length}: filial ${item.codigoFilial}, período ${item.periodo}`,
        );
        await this.executarItem(instanciaId, item);
        this.estado.itensConcluidos++;
      }
      await this.store.expurgar(instanciaId, RETENCAO_ANOS, agora);
      this.registrarTrabalho('info', 'expurgo de retenção concluído');
      await this.ancora.verificarPeriodosCongelados(instanciaId, filiais);
      this.registrarTrabalho('info', 'verificação de âncora concluída');

      if (this.estado.cancelado) {
        this.registrarTrabalho('warn', 'sincronização cancelada pelo usuário');
      } else if (this.estado.erros.length) {
        this.registrarTrabalho(
          'warn',
          `sincronização encerrada com ${this.estado.erros.length} aviso(s)`,
        );
      } else {
        this.registrarTrabalho(
          'ok',
          `sincronização concluída · ${this.estado.linhas.toLocaleString('pt-BR')} pedidos gravados`,
        );
      }
    } finally {
      this.estado.rodando = false;
      this.estado.itemAtual = undefined;
      this.estado.trabalho = [...this.historicoTrabalho];
    }
  }

  /**
   * Varre um (filial × período) inteiro, página a página.
   *
   * As guardas espelham `varrerPedidos`, pela mesma razão: a semântica de página
   * do upstream nunca foi verificada além de `page=1`. Se um lote não traz nada
   * novo, a paginação não avançou — parar é a única saída segura, e o lote sai
   * como `parcial`, sem publicar cobertura.
   */
  private async executarItem(
    instanciaId: number,
    item: ItemPlano,
  ): Promise<void> {
    const loteId = this.store.abrirLote({
      instanciaId,
      codigoFilial: item.codigoFilial,
      periodo: item.periodo,
      posicaoPedido: POSICAO_INGESTAO,
      margemMinLucro: MARGEM_PADRAO,
      janela: item.janela,
    });

    const vistos = new Set<string>();
    let paginas = 0;
    let totalUpstream: number | undefined;
    let valorUpstream: number | undefined;
    let custoUpstream: number | undefined;
    let completa = false;
    let motivo: string | undefined;
    /**
     * pageSize adaptativo por lote: começa no padrão e cai se o ERP devolver
     * resposta maior que o teto de bytes (comum em período anual).
     */
    let pageSize = INGESTAO_PAGE_SIZE;

    for (let page = 1; ; page++) {
      if (this.cancelar_) {
        motivo = 'cancelado pelo usuário';
        break;
      }

      const r = await this.buscarPaginaComRetry(item, page, pageSize);
      if (!r.ok) {
        const msg = r.error ?? 'falha na chamada ao WinThor';
        await this.store.fecharLote(loteId, {
          estado: 'falhou',
          paginas,
          motivo: msg,
        });
        this.registrarTrabalho(
          'error',
          `filial ${item.codigoFilial}, período ${item.periodo}: ${msg}`,
        );
        this.estado.erros.push(
          `filial ${item.codigoFilial}, periodo ${item.periodo}: ${msg}`,
        );
        return;
      }
      pageSize = r.pageSize;

      paginas++;
      this.estado.paginas++;
      const lote = r.data?.items ?? [];
      totalUpstream = r.data?.total ?? totalUpstream;
      // O totalizer é do conjunto filtrado inteiro, não da página — é o alvo
      // exato da conferência do fechamento.
      valorUpstream =
        numeroDoTotalizer(r.data?.totalizer, 'VALOR_PEDIDO') ?? valorUpstream;
      custoUpstream =
        numeroDoTotalizer(r.data?.totalizer, 'CUSTO_FINANCEIRO') ??
        custoUpstream;

      if (lote.length === 0) {
        completa = true;
        break;
      }

      const antes = vistos.size;
      for (const pedido of lote) {
        // Só escalar vira chave direta: `String({})` daria '[object Object]' e
        // faria pedidos distintos colidirem, o que a guarda abaixo leria como
        // "página repetida" — encerrando uma varredura sadia como parcial.
        const numero = pedido.NUMERO_PEDIDO;
        vistos.add(
          typeof numero === 'string' || typeof numero === 'number'
            ? String(numero)
            : JSON.stringify(pedido),
        );
      }
      if (vistos.size === antes) {
        motivo = 'upstream repetiu a página; paginação não avançou';
        break;
      }

      const gravado = await this.store.gravarPagina(loteId, lote, page + 1);
      this.estado.linhas += gravado.gravados;

      if (paginas === 1 || paginas % 10 === 0) {
        this.registrarTrabalho(
          'info',
          `filial ${item.codigoFilial}, período ${item.periodo}: página ${paginas} · ${vistos.size} pedido(s)`,
        );
      }

      if (totalUpstream !== undefined && vistos.size >= totalUpstream) {
        completa = true;
        break;
      }
      if (lote.length < pageSize) {
        // Página curta normalmente é o fim. Mas se o upstream declarou um total
        // maior, ele não honrou `countDataPage` — encerrar como completa aqui
        // publicaria cobertura sobre uma varredura incompleta.
        if (totalUpstream !== undefined && vistos.size < totalUpstream) {
          motivo = `página curta (${lote.length}) com ${totalUpstream} disponíveis: countDataPage não honrado`;
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
      valorUpstream,
      custoUpstream,
      motivo,
    });

    const rotuloEstado = completa
      ? fechamento.confere === false
        ? 'conferência reprovada'
        : 'completo'
      : (motivo ?? 'parcial');
    this.registrarTrabalho(
      fechamento.confere === false || !completa ? 'warn' : 'ok',
      `filial ${item.codigoFilial}, período ${item.periodo}: ${rotuloEstado} · ${paginas} página(s) · ${fechamento.linhas} pedido(s)`,
    );

    if (fechamento.confere === false) {
      this.estado.erros.push(
        `filial ${item.codigoFilial}, periodo ${item.periodo}: conferência falhou ` +
          `(${fechamento.divergenciaPct?.toFixed(2)}%)`,
      );
    } else if (!completa) {
      this.estado.erros.push(
        `filial ${item.codigoFilial}, periodo ${item.periodo}: ${motivo ?? 'varredura incompleta'}`,
      );
    }
  }

  /**
   * Busca uma página com redução de pageSize em overflow e retry em falha
   * transitória (timeout / rede). Mantém o pageSize efetivo para as próximas.
   */
  private async buscarPaginaComRetry(
    item: ItemPlano,
    page: number,
    pageSizeInicial: number,
  ): Promise<WinthorApiResult<GridResult> & { pageSize: number }> {
    let pageSize = pageSizeInicial;
    let tentativasTransitorias = 0;

    for (;;) {
      const r = await this.mobile.listarLucratividade(
        ENDPOINTS.pedidosDeVenda,
        [...COLUNAS],
        {
          listaFilial: [item.codigoFilial],
          periodo: item.periodo,
          posicaoPedido: POSICAO_INGESTAO,
          margemMinLucro: MARGEM_PADRAO,
          perspectiva: '1',
          page,
          pageSize,
        },
      );

      if (r.ok) return { ...r, pageSize };

      const erro = r.error ?? '';
      if (ePayloadGrande(erro) && pageSize > INGESTAO_PAGE_SIZE_MIN) {
        const novo = Math.max(INGESTAO_PAGE_SIZE_MIN, Math.floor(pageSize / 2));
        const msg =
          `filial ${item.codigoFilial}, período ${item.periodo}, página ${page}: ` +
          `payload grande — pageSize ${pageSize}→${novo}`;
        this.registrarTrabalho('warn', msg);
        pageSize = novo;
        continue;
      }

      if (eTransitorio(erro) && tentativasTransitorias < INGESTAO_RETRY_MAX) {
        tentativasTransitorias++;
        const esperaMs = 1_000 * tentativasTransitorias;
        const msg =
          `filial ${item.codigoFilial}, período ${item.periodo}, página ${page}: ` +
          `${erro} — retry ${tentativasTransitorias}/${INGESTAO_RETRY_MAX} em ${esperaMs}ms`;
        this.registrarTrabalho('warn', msg);
        if (tentativasTransitorias >= 2 && pageSize > INGESTAO_PAGE_SIZE_MIN) {
          pageSize = Math.max(INGESTAO_PAGE_SIZE_MIN, Math.floor(pageSize / 2));
        }
        await this.esperarRetry(esperaMs);
        continue;
      }

      return { ...r, pageSize };
    }
  }

  /**
   * Aprende o mapa código→rótulo de `POSICAO_PEDIDO` com 4 chamadas de 1 linha.
   *
   * A linha devolvida sob o filtro `posicaoPedido: c` traz o rótulo daquele
   * código. É a diferença entre saber e supor: sem isto, filtrar por "faturado"
   * localmente dependeria de adivinhar que o rótulo é `'FATURADO'`.
   */
  private async aprenderPosicoes(
    instanciaId: number,
    filial: string,
  ): Promise<void> {
    const mapa: Record<string, string> = {};
    for (const codigo of ['1', '2', '3', '4']) {
      const r = await this.mobile.listarLucratividade(
        ENDPOINTS.pedidosDeVenda,
        [...COLUNAS],
        {
          listaFilial: [filial],
          periodo: '7',
          posicaoPedido: codigo,
          margemMinLucro: MARGEM_PADRAO,
          perspectiva: '1',
          page: 1,
          pageSize: 1,
        },
      );
      const rotulo = r.ok ? r.data?.items[0]?.POSICAO_PEDIDO : undefined;
      if (typeof rotulo === 'string' && rotulo) mapa[codigo] = rotulo;
    }
    if (Object.keys(mapa).length) {
      this.store.aprenderPosicoes(instanciaId, mapa);
      this.logger.log(`posições aprendidas do ERP: ${JSON.stringify(mapa)}`);
    }
  }

  /**
   * Prova a derivação do dia contra o ERP.
   *
   * `periodo: '2'` (Ontem) é uma janela de **um dia só**, então a varredura tem
   * de produzir um único `dia` distinto, igual a ontem. Se produzir dois, a
   * hipótese de meia-noite local quebrou neste ERP e a base inteira estaria
   * deslocada — melhor não publicar cobertura nenhuma que publicar tudo errado.
   *
   * Dia sem venda nenhuma não falsifica nada: devolve `true` e a prova fica para
   * a próxima rodada.
   */
  private async verificarDerivacaoDeDia(
    instanciaId: number,
    filial: string,
  ): Promise<boolean> {
    const agora = new Date();
    const ontem = janelaDoPeriodo('2', agora).dataInicio;

    const r = await this.mobile.listarLucratividade(
      ENDPOINTS.pedidosDeVenda,
      [...COLUNAS],
      {
        listaFilial: [filial],
        periodo: '2',
        posicaoPedido: POSICAO_INGESTAO,
        margemMinLucro: MARGEM_PADRAO,
        perspectiva: '1',
        page: 1,
        pageSize: INGESTAO_PAGE_SIZE,
      },
    );
    if (!r.ok) return true; // falha de rede não é falsificação da hipótese

    const itens = r.data?.items ?? [];
    if (!itens.length) return true;

    const dias = new Set(
      itens
        .map((i) => diaDoPedidoSeguro(i.DATA_PEDIDO))
        .filter((d): d is string => d !== null),
    );

    if (dias.size === 1 && dias.has(ontem)) {
      this.store.marcarDiaVerificado(instanciaId, agora);
      return true;
    }

    this.logger.error(
      `derivação do dia NÃO confirmada: 'Ontem' (${ontem}) produziu ` +
        `${dias.size} dia(s) distinto(s): ${[...dias].join(', ')}. ` +
        `DATA_PEDIDO pode não ser meia-noite local neste ERP.`,
    );
    return false;
  }

  /** Cede a vez: pausa maior enquanto há tool call em voo. */
  private pausar(): Promise<void> {
    const ms =
      Date.now() < this.ocupadoAte
        ? INGESTAO_PAUSA_OCUPADO_MS
        : INGESTAO_PAUSA_MS;
    return new Promise((resolve) => {
      // `unref` para uma pausa pendente nunca segurar o encerramento do processo.
      setTimeout(resolve, ms).unref();
    });
  }

  private esperarRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    });
  }

  /** Só para os testes: encurta as pausas sem esperar segundos de verdade. */
  static semPausa(servico: VendasIngestaoService): void {
    const noop = () => Promise.resolve();
    (servico as unknown as { pausar: () => Promise<void> }).pausar = noop;
    (servico as unknown as { esperarRetry: () => Promise<void> }).esperarRetry =
      noop;
  }

  private registrarTrabalho(nivel: NivelTrabalho, mensagem: string): void {
    const linha: LinhaTrabalho = {
      em: new Date().toISOString(),
      nivel,
      mensagem,
    };
    this.historicoTrabalho.push(linha);
    if (this.historicoTrabalho.length > MAX_LINHAS_TRABALHO) {
      this.historicoTrabalho.shift();
    }
    this.estado.trabalho = [...this.historicoTrabalho];

    const prefixo = `[wt.ai sync] ${mensagem}`;
    if (nivel === 'error') {
      this.logger.error(mensagem);
      console.error(prefixo);
    } else if (nivel === 'warn') {
      this.logger.warn(mensagem);
      console.warn(prefixo);
    } else {
      this.logger.log(mensagem);
      console.log(prefixo);
    }
  }
}

function vazio(): StatusIngestao {
  return {
    rodando: false,
    itensTotal: 0,
    itensConcluidos: 0,
    paginas: 0,
    linhas: 0,
    erros: [],
    cancelado: false,
    trabalho: [],
  };
}

/** Mesma disciplina de `metricaNumerica`: só número finito conta. */
function numeroDoTotalizer(
  totalizer: Record<string, number> | undefined,
  chave: string,
): number | undefined {
  const valor = totalizer?.[chave];
  return typeof valor === 'number' && Number.isFinite(valor)
    ? valor
    : undefined;
}

function diaDoPedidoSeguro(valor: unknown): string | null {
  const instante =
    typeof valor === 'number' || typeof valor === 'string'
      ? new Date(valor)
      : null;
  return instante && !Number.isNaN(instante.getTime())
    ? diaNoErp(instante)
    : null;
}

/** Resposta cortada por `MAX_UPSTREAM_BYTES` — reduzir pageSize resolve. */
function ePayloadGrande(erro: string): boolean {
  return /passou de \d+ bytes/i.test(erro) || /reduza pagesize/i.test(erro);
}

/** Falhas de rede/ERP que merecem retry antes de falhar o lote. */
function eTransitorio(erro: string): boolean {
  return (
    /timeout/i.test(erro) ||
    /fetch failed/i.test(erro) ||
    /econnreset/i.test(erro) ||
    /econnrefused/i.test(erro) ||
    /socket hang up/i.test(erro) ||
    /network/i.test(erro)
  );
}
