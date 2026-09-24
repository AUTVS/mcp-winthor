import { Injectable, Logger, Optional } from '@nestjs/common';
import { WtConfigService } from '../config/wt-config.service';
import { janelaDoPeriodo, Janela } from '../vendas/periodo-janela';
import {
  DimensaoLocal,
  VendasQueryService,
} from '../vendas/vendas-query.service';
import {
  clampPage,
  clampPageSize,
  LIST_CACHE_MAX_CHARS,
  LIST_CACHE_MAX_ENTRIES,
  LIST_CACHE_TTL_MS,
  MAX_SCAN_PEDIDOS,
  SCAN_PAGE_SIZE,
  TOLERANCIA_CONFERENCIA_PCT,
} from '../config/limits';
import {
  arredondar,
  finalizarLinhas,
  LinhaFaturamento,
  num,
} from '../vendas/agregacao';
import { estimarChars, TtlCache } from './ttl-cache';
import { WinthorApiService, WinthorApiResult } from './winthor-api.service';
import {
  col,
  ColunaGrid,
  DataModelResponse,
  ENDPOINTS,
  Filtros,
  GridResponse,
  GridResult,
  MOBILE_BASE,
  PERIODOS,
  PERIODO_PADRAO,
  PeriodoCodigo,
  toCodigo,
} from './winthor-mobile.types';

/** Menor epoch-ms tratado como data (≈ 1973); abaixo disso é número de negócio. */
const EPOCH_MINIMO = 1e11;

/** Acima disso, avisa que a consulta foi expandida por falta de listaFilial. */
const FILIAIS_ALERTA = 3;

/**
 * Colunas pedidas na varredura de faturamento. O backend ignora `data.list` no
 * SELECT e devolve o pedido completo de qualquer jeito (§6.8), então a lista
 * serve só para marcar o que entra no `totalizer` do upstream.
 */
const COLUNAS_FATURAMENTO: ColunaGrid[] = [
  col('CODIGO_CLIENTE'),
  col('NOME_CLIENTE'),
  col('VALOR_PEDIDO', true),
  col('CUSTO_FINANCEIRO', true),
];

/** Colunas do agregado nativo por RCA (§4.4). */
const COLUNAS_RCA: ColunaGrid[] = [
  col('CODIGO'),
  col('NOME'),
  col('VALOR_TOTAL', true),
  col('VALOR_CUSTO_FINANCEIRO', true),
  col('PERC_CMV'),
  col('VALOR_LUCRO', true),
  col('PERC_LUCRO'),
];

export type Dimensao = 'cliente' | 'filial' | 'supervisor' | 'rca';
type DimensaoEnumeravel = 'filial' | 'supervisor';

/**
 * Como cada dimensão enumerável vira filtro e linha. `listaTipoCobranca` não
 * entra: é filtro só da W120, não alcança a W106.
 */
const DIMENSOES: Record<
  DimensaoEnumeravel,
  {
    chaveFiltro: string;
    chaveCodigo: string;
    chaveNome: string;
    campoNomeNaLinha: string;
  }
> = {
  filial: {
    chaveFiltro: 'listaFilial',
    chaveCodigo: 'CODIGO_FILIAL',
    chaveNome: 'NOME_FILIAL',
    campoNomeNaLinha: 'NOME_FILIAL',
  },
  supervisor: {
    chaveFiltro: 'listaSupervisor',
    chaveCodigo: 'CODIGO_SUPERVISOR',
    chaveNome: 'NOME_SUPERVISOR',
    campoNomeNaLinha: 'NOME_SUPERVISOR',
  },
};

interface AgregadoDimensao {
  linhas: LinhaFaturamento[];
  conferencia: {
    somaDimensao: number;
    totalGeral: number | null;
    divergenciaPct: number;
    confere: boolean;
  };
  somaCount: number;
  countGeral: number;
  custoDisponivel: boolean;
}

/**
 * Lê uma métrica do totalizer SEM coerção.
 *
 * `num()` devolveria 0 para `"600.793,14"` em pt-BR, e aí lucro = faturado e
 * margem = 100% — número errado de aparência plausível. Ausente tem de
 * significar ausente.
 */
function metricaNumerica(
  totalizer: Record<string, unknown>,
  chave: string,
): number | undefined {
  const valor = totalizer[chave];
  return typeof valor === 'number' && Number.isFinite(valor)
    ? valor
    : undefined;
}

/** Chave de cache estável: JSON.stringify respeita ordem de inserção. */
function chaveEstavel(obj: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]]),
  );
}

interface Varredura {
  pedidos: number;
  paginas: number;
  completa: boolean;
  totalUpstream?: number;
  motivo?: string;
  /** Consulta ampla demais: recusada antes de varrer, não varrida pela metade. */
  acimaDoTeto?: boolean;
}

interface Agregado {
  linhas: LinhaFaturamento[];
  varredura: Varredura;
}

/** Chave de agrupamento só a partir de escalar; objeto vira string vazia. */
function chaveDe(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : '';
}

interface Paginacao {
  page?: number;
  pageSize?: number;
}

@Injectable()
export class WinthorMobileService {
  private readonly logger = new Logger(WinthorMobileService.name);

  /**
   * Listas que o upstream não pagina. Substitui o antigo `filiaisCache`, que
   * não tinha TTL nenhum: uma filial criada no WinThor só aparecia depois de
   * reiniciar o processo.
   */
  private readonly listCache = new TtlCache<unknown>({
    ttlMs: LIST_CACHE_TTL_MS,
    maxEntries: LIST_CACHE_MAX_ENTRIES,
    maxChars: LIST_CACHE_MAX_CHARS,
  });

  constructor(
    private readonly configService: WtConfigService,
    private readonly api: WinthorApiService,
    /**
     * Base local de vendas. `@Optional()` de propósito: os specs instanciam este
     * serviço à mão com dois argumentos (`winthor-mobile.service.spec.ts`), e
     * ausente significa base desligada, com o comportamento idêntico ao de antes
     * de ela existir.
     */
    @Optional() private readonly vendas?: VendasQueryService,
  ) {}

  /** Vazia quando não configurado, o que desliga o cache. */
  private chaveConfig(): string {
    const cfg = this.configService.getConfig();
    return cfg ? `${cfg.winthorBaseUrl}|${cfg.login}|${cfg.configuredAt}` : '';
  }

  // -------------------------------------------------------------------------
  // Envelopes de requisição (§1.3)
  // -------------------------------------------------------------------------

  /**
   * Envelope completo GRID_MODEL. `parameters.parameters` tem dupla aninhação
   * obrigatória — colocar o filtro um nível acima retorna HTTP 500 (§6.2).
   * Paginação viaja como string (§6.4).
   */
  private gridRequest(
    colunas: ColunaGrid[],
    parameters: Filtros,
    page: number,
    pageSize: number,
  ) {
    return {
      data: { list: colunas },
      parameters: { parameters },
      paginator: {
        nextPage: String(page),
        countDataPage: String(pageSize),
        paginator: true,
      },
      dataChart: {},
    };
  }

  /** Envelope reduzido, usado só por consultarValorCarteira e pesquisarFilial. */
  private dataRequest(data: Filtros) {
    return { data };
  }

  // -------------------------------------------------------------------------
  // Normalização das respostas (§1.4)
  // -------------------------------------------------------------------------

  /**
   * Converte epoch-ms para ISO nas chaves de data (§6.7). Restrito a chaves que
   * começam com DATA e a valores acima do limiar, para não estragar campos
   * numéricos de negócio.
   */
  private normalizeValores(registro: Record<string, unknown>) {
    const saida: Record<string, unknown> = {};
    for (const [chave, valor] of Object.entries(registro)) {
      if (
        chave.toUpperCase().startsWith('DATA') &&
        typeof valor === 'number' &&
        Math.abs(valor) >= EPOCH_MINIMO
      ) {
        saida[chave] = new Date(valor).toISOString();
      } else {
        saida[chave] = valor;
      }
    }
    return saida;
  }

  /** Desembrulha data.list[].data e lê o total de paginator.count (§6.6). */
  private normalizeGrid(
    raw: GridResponse | undefined,
    page: number,
    pageSize: number,
  ): GridResult {
    const lista = raw?.data?.list ?? [];
    const items = lista.map((item) =>
      this.normalizeValores(item.data ?? item.dataModel ?? {}),
    );
    const total = raw?.paginator?.count;

    return {
      items,
      count: items.length,
      page,
      pageSize,
      total,
      totalPages:
        typeof total === 'number' && pageSize > 0
          ? Math.ceil(total / pageSize)
          : undefined,
      totalizer: raw?.totalizer ?? undefined,
    };
  }

  private normalizeDataModel(raw: DataModelResponse | undefined) {
    return this.normalizeValores(raw?.data ?? raw?.dataModel ?? {});
  }

  // -------------------------------------------------------------------------
  // Chamadas genéricas
  // -------------------------------------------------------------------------

  private async grid(
    endpoint: string,
    colunas: ColunaGrid[],
    parameters: Filtros,
    paginacao?: Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const page = clampPage(paginacao?.page);
    const pageSize = clampPageSize(paginacao?.pageSize);

    const result = await this.api.postJson<GridResponse>(
      `${MOBILE_BASE}/${endpoint}`,
      this.gridRequest(colunas, parameters, page, pageSize),
    );

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      };
    }

    return {
      ok: true,
      status: result.status,
      data: this.normalizeGrid(result.data, page, pageSize),
    };
  }

  private async dataModel(
    endpoint: string,
    data: Filtros,
  ): Promise<WinthorApiResult<Record<string, unknown>>> {
    const result = await this.api.postJson<DataModelResponse>(
      `${MOBILE_BASE}/${endpoint}`,
      this.dataRequest(data),
    );

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      };
    }

    return {
      ok: true,
      status: result.status,
      data: this.normalizeDataModel(result.data),
    };
  }

  // -------------------------------------------------------------------------
  // Filtros compartilhados
  // -------------------------------------------------------------------------

  /** `periodo` e `descricaoPeriodo` viajam sempre juntos (§1.5). */
  periodoFiltro(periodo?: PeriodoCodigo) {
    const codigo = periodo ?? PERIODO_PADRAO;
    return { periodo: codigo, descricaoPeriodo: PERIODOS[codigo] };
  }

  /**
   * Códigos de filial a usar quando o chamador não informa nenhum: todas as
   * filiais visíveis ao usuário configurado. Cacheado por configuração.
   */
  async filiaisPadrao(): Promise<string[]> {
    const base = this.chaveConfig();
    const codigos = await this.listCache.getOrLoad(
      base ? `${base}|filiaisPadrao` : '',
      async () => {
        const usuario = await this.buscarUsuarioLogado();
        const matricula = usuario.ok ? toCodigo(usuario.data?.MATRICULA) : null;
        if (matricula === null) return null;

        const filiais = await this.pesquisarFilial(matricula);
        if (!filiais.ok) return null;

        const lista = (filiais.data?.items ?? [])
          .map((f) => toCodigo(f.CODIGO))
          .filter((c): c is string => c !== null);
        return { valor: lista, chars: estimarChars(lista) };
      },
    );

    return (codigos as string[] | null) ?? [];
  }

  private async resolverFiliais(listaFilial?: string[]): Promise<string[]> {
    if (listaFilial && listaFilial.length > 0) {
      return listaFilial.map(String);
    }
    return this.filiaisPadrao();
  }

  limparCache(): void {
    this.listCache.clear();
  }

  /**
   * Omitir `listaFilial` faz `resolverFiliais` expandir para todas as filiais
   * visíveis — o oposto de restringir, e uma das causas de resposta gigante.
   * Não dá para truncar a lista (produziria totais errados), então ecoa o que
   * foi aplicado e avisa quando a expansão for grande.
   */
  private anotarFiliais(
    resultado: WinthorApiResult<GridResult>,
    filtros: Filtros,
    informouFilial: boolean,
  ): WinthorApiResult<GridResult> {
    const aplicadas = filtros.listaFilial;
    if (!resultado.ok || !resultado.data || !Array.isArray(aplicadas)) {
      return resultado;
    }

    resultado.data.filiaisAplicadas = aplicadas.map(String);
    if (!informouFilial && aplicadas.length > FILIAIS_ALERTA) {
      resultado.data.hint = `Consulta expandida para ${aplicadas.length} filiais. Informe listaFilial para reduzir.`;
    }
    return resultado;
  }

  // -------------------------------------------------------------------------
  // Endpoints comuns (§2)
  // -------------------------------------------------------------------------

  async buscarUsuarioLogado(): Promise<
    WinthorApiResult<Record<string, unknown>>
  > {
    const result = await this.api.postJson<DataModelResponse>(
      `${MOBILE_BASE}/${ENDPOINTS.usuarioLogado}`,
      {},
    );
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      };
    }
    return {
      ok: true,
      status: result.status,
      data: this.normalizeDataModel(result.data),
    };
  }

  /**
   * `matricula` precisa ser string — número retorna HTTP 500 (§2.2).
   *
   * O endpoint usa o envelope reduzido e não aceita `paginator` (§6.3), então
   * a paginação, quando pedida, é aplicada em processo. **Sem `paginacao` a
   * lista volta inteira**: `filiaisPadrao()` deriva `listaFilial` daqui, e
   * paginar por padrão estreitaria silenciosamente toda consulta W120/W106.
   */
  async pesquisarFilial(
    matricula: string,
    paginacao?: Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const result = await this.api.postJson<GridResponse>(
      `${MOBILE_BASE}/${ENDPOINTS.pesquisarFilial}`,
      this.dataRequest({ matricula: String(matricula) }),
    );
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      };
    }

    const lista = result.data?.data?.list ?? [];
    const paginar =
      paginacao?.page !== undefined || paginacao?.pageSize !== undefined;

    if (!paginar) {
      return {
        ok: true,
        status: result.status,
        data: this.normalizeGrid(result.data, 1, lista.length),
      };
    }

    const page = clampPage(paginacao?.page);
    const pageSize = clampPageSize(paginacao?.pageSize);
    const inicio = (page - 1) * pageSize;

    // Fatia antes de normalizar: o custo por linha acompanha a página, não a
    // lista inteira.
    const pagina = {
      ...result.data,
      data: { list: lista.slice(inicio, inicio + pageSize) },
      paginator: { ...result.data?.paginator, count: lista.length },
    };

    return {
      ok: true,
      status: result.status,
      data: this.normalizeGrid(pagina, page, pageSize),
    };
  }

  // -------------------------------------------------------------------------
  // W120 — Resumo de Inadimplência (§3)
  // -------------------------------------------------------------------------

  /** Bloco de filtros idêntico em todos os listarResumo... (§3.2). */
  private async filtrosInadimplencia(args: {
    listaFilial?: string[];
    periodo?: PeriodoCodigo;
    listaCliente?: string[];
    listaSupervisor?: string[];
    listaTipoCobranca?: string[];
  }): Promise<Filtros> {
    return {
      listaFilial: await this.resolverFiliais(args.listaFilial),
      ...this.periodoFiltro(args.periodo),
      listaCliente: args.listaCliente?.map(String) ?? null,
      listaSupervisor: args.listaSupervisor?.map(String) ?? null,
      listaTipoCobranca: args.listaTipoCobranca?.map(String) ?? null,
    };
  }

  async listarInadimplencia(
    endpoint: string,
    colunas: ColunaGrid[],
    args: Parameters<WinthorMobileService['filtrosInadimplencia']>[0] &
      Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const filtros = await this.filtrosInadimplencia(args);
    return this.anotarFiliais(
      await this.grid(endpoint, colunas, filtros, args),
      filtros,
      !!args.listaFilial?.length,
    );
  }

  /** Não recebe período: a carteira é sempre a posição atual (§3.4). */
  async consultarValorCarteira(
    listaFilial?: string[],
  ): Promise<WinthorApiResult<Record<string, unknown>>> {
    return this.dataModel(ENDPOINTS.valorCarteira, {
      listaFilial: await this.resolverFiliais(listaFilial),
    });
  }

  // -------------------------------------------------------------------------
  // W106 — Lucratividade (§4)
  // -------------------------------------------------------------------------

  /** Bloco de filtros enviado em todas as listagens da W106 (§4.2). */
  private async filtrosLucratividade(args: {
    listaFilial?: string[];
    periodo?: PeriodoCodigo;
    listaCliente?: string[];
    listaEmitente?: string[];
    listaRca?: string[];
    listaSupervisor?: string[];
    margemMinLucro?: string;
    numeroPedido?: string;
    numeroPedidoRca?: string;
    posicaoPedido?: string;
    perspectiva: '1' | '2';
  }): Promise<Filtros> {
    return {
      listaFilial: await this.resolverFiliais(args.listaFilial),
      listaCliente: args.listaCliente?.map(String) ?? null,
      listaEmitente: args.listaEmitente?.map(String) ?? null,
      listaRca: args.listaRca?.map(String) ?? null,
      listaSupervisor: args.listaSupervisor?.map(String) ?? null,
      margemMinLucro: args.margemMinLucro ?? '100',
      numeroPedido: args.numeroPedido ?? '',
      numeroPedidoRca: args.numeroPedidoRca ?? '',
      posicaoPedido: args.posicaoPedido ?? '0',
      ...this.periodoFiltro(args.periodo),
      perspectiva: args.perspectiva,
    };
  }

  async listarLucratividade(
    endpoint: string,
    colunas: ColunaGrid[],
    args: Parameters<WinthorMobileService['filtrosLucratividade']>[0] &
      Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const filtros = await this.filtrosLucratividade(args);
    return this.anotarFiliais(
      await this.grid(endpoint, colunas, filtros, args),
      filtros,
      !!args.listaFilial?.length,
    );
  }

  /**
   * Faturamento agregado por cliente — uma linha por cliente, não por pedido.
   *
   * O WinThor **não expõe** essa agregação: a rotina W106 só tem as
   * perspectivas "por pedido" e "por RCA" (§4.4), e `perspectiva` é campo de
   * filtro passivo, não roteador — não há um terceiro endpoint para alcançar.
   * Então o servidor varre `listarPedidosDeVenda` para si mesmo e agrega aqui.
   *
   * O ganho não é evitar a paginação e sim tirar o modelo dela: quem percorre
   * as páginas é este laço, uma vez por janela de cache, em vez de o assistente
   * gastar dezenas de idas e voltas para somar na mão.
   */
  async agregarFaturamento(
    args: Omit<
      Parameters<WinthorMobileService['filtrosLucratividade']>[0],
      'perspectiva'
    > &
      Paginacao & {
        agruparPor?: Dimensao;
        permitirRebaixar?: boolean;
        /**
         * Recorte por data livre — capacidade que o WinThor **não** tem (o
         * filtro é um enum fechado de período). Só a base local atende.
         */
        dataInicio?: string;
        dataFim?: string;
      },
  ): Promise<WinthorApiResult<GridResult>> {
    const solicitado: Dimensao = args.agruparPor ?? 'cliente';

    // RCA delega ao MESMO caminho de wt_lucratividade_por_rca. Duas rotas para
    // o mesmo número que pudessem divergir seriam pior que não ter a rota.
    if (solicitado === 'rca') {
      const r = await this.listarLucratividade(
        ENDPOINTS.lucratividadePorRca,
        [...COLUNAS_RCA],
        { ...args, perspectiva: '2' },
      );
      if (r.ok && r.data) {
        r.data.agrupadoPor = 'rca';
        r.data.fonte = 'agregado-upstream';
        for (const linha of r.data.items) linha.NIVEL = 'rca';
      }
      return r;
    }

    // Base local primeiro: o mesmo recorte que hoje é recusado por teto sai em
    // milissegundos. Ela só responde quando consegue PROVAR cobertura da janela
    // inteira; em qualquer outro caso o caminho ao vivo abaixo segue idêntico.
    const local = await this.tentarBaseLocal(solicitado, args);
    if (local) return local;

    // Data livre sem cobertura NÃO cai para o enum de período. Trocar em
    // silêncio "01/03 a 15/03" por "mês atual" seria a versão temporal do número
    // plausível-e-errado que o resto do serviço recusa a cada passo: o
    // assistente receberia números certos para uma pergunta que não fez.
    if (args.dataInicio || args.dataFim) {
      return {
        ok: true,
        status: 200,
        data: {
          items: [],
          count: 0,
          page: clampPage(args.page),
          pageSize: clampPageSize(args.pageSize),
          total: 0,
          totalPages: 0,
          fonte: 'base-local',
          hint:
            `Recorte por data livre só é atendido pela base local, e ela ainda não cobre ` +
            `${args.dataInicio ?? '?'} a ${args.dataFim ?? '?'} nas filiais pedidas. ` +
            `Use wt_vendas_base_local para ver a cobertura e sincronizar, ou refaça a ` +
            `consulta com o parâmetro periodo.`,
        },
      };
    }

    // Objeto base ÚNICO, já resolvido: posicaoPedido '4' e listaFilial saem
    // daqui para todas as chamadas. Remontar por dimensão é como os totais
    // divergem em silêncio.
    const filtrosBase = await this.filtrosLucratividade({
      ...args,
      // "4" = Faturado (§4.3): sem isso a soma incluiria pedido bloqueado e
      // pendente, que ainda não é faturamento.
      posicaoPedido: args.posicaoPedido ?? '4',
      perspectiva: '1',
    });

    if (solicitado !== 'cliente') {
      return this.agregarPorDimensao(solicitado, filtrosBase, args, solicitado);
    }

    const porCliente = await this.agregarPorCliente(filtrosBase, args);
    const meta = porCliente.ok ? porCliente.data?.varredura : undefined;

    // Estourou o teto: em vez de recusar, cai para uma agregação mais grossa —
    // exata e sem varredura. Dado certo em outra granularidade, não amostra.
    if (meta?.acimaDoTeto && args.permitirRebaixar !== false) {
      return this.agregarPorDimensao(
        'filial',
        filtrosBase,
        args,
        'cliente',
        meta.totalUpstream,
      );
    }
    return porCliente;
  }

  /**
   * Dimensões que a base local atende.
   *
   * `supervisor` fica de fora porque **a linha do pedido não traz supervisor**
   * (§4.4) — `agregarPorDimensao` o resolve enumerando o lookup e fazendo uma
   * chamada por supervisor, e esse caminho já é exato e barato.
   *
   * `rca` também fica de fora, e por um motivo diferente: ele já tem um agregado
   * NATIVO do WinThor, para o qual `agregarFaturamento` delega de propósito. Ter
   * uma segunda rota que somasse RCA em processo recriaria exatamente o problema
   * que aquela delegação evita — dois números para a mesma pergunta.
   */
  private static readonly DIMENSOES_DA_BASE_LOCAL = new Set<Dimensao>([
    'cliente',
    'filial',
  ]);

  /**
   * Tenta responder pela base local. `null` = não deu, siga ao vivo.
   *
   * Nunca lança e nunca degrada em silêncio: qualquer motivo de recusa devolve
   * `null`, e o caminho de sempre assume.
   */
  private async tentarBaseLocal(
    dimensao: Dimensao,
    args: Parameters<WinthorMobileService['agregarFaturamento']>[0] & {
      dataInicio?: string;
      dataFim?: string;
    },
  ): Promise<WinthorApiResult<GridResult> | null> {
    if (!this.vendas) return null;
    if (!WinthorMobileService.DIMENSOES_DA_BASE_LOCAL.has(dimensao))
      return null;

    const janela: Janela =
      args.dataInicio && args.dataFim
        ? { dataInicio: args.dataInicio, dataFim: args.dataFim }
        : janelaDoPeriodo(args.periodo ?? PERIODO_PADRAO);

    const filiais = await this.resolverFiliais(args.listaFilial);

    const r = await this.vendas.agregar({
      dimensao: dimensao as DimensaoLocal,
      filiais,
      janela,
      posicaoPedido: args.posicaoPedido ?? '4',
      margemMinLucro: args.margemMinLucro,
      listaCliente: args.listaCliente,
      listaRca: args.listaRca,
      listaEmitente: args.listaEmitente,
      page: args.page,
      pageSize: args.pageSize,
    });

    if (!r.atendivel) {
      this.logger.debug(`base local não atendeu: ${r.motivo}`);
      return null;
    }
    return { ok: true, status: 200, data: r.resultado };
  }

  private async agregarPorCliente(
    filtros: Filtros,
    args: Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const base = this.chaveConfig();
    const chave = base ? `${base}|fatPorCliente|${chaveEstavel(filtros)}` : '';

    const falhas: WinthorApiResult<unknown>[] = [];
    const cacheado = (await this.listCache.getOrLoad(chave, async () => {
      const varrido = await this.varrerPedidos(filtros);
      if (!varrido.ok) {
        falhas.push(varrido.erro);
        return null;
      }
      const valor: Agregado = {
        // Acima do teto não se agrega: um ranking sobre as primeiras 200 de
        // 13 mil linhas seria resposta errada com aviso, não amostra.
        linhas: varrido.varredura.acimaDoTeto
          ? []
          : this.somarPorCliente(varrido.pedidos),
        varredura: varrido.varredura,
      };
      return { valor, chars: estimarChars(valor.linhas) };
    })) as Agregado | null;

    if (cacheado === null) {
      const falha = falhas[0];
      return {
        ok: false,
        status: falha?.status ?? 0,
        error: falha?.error ?? 'Falha ao varrer os pedidos para agregar.',
        raw: falha?.raw,
      };
    }

    const { linhas: agregado, varredura: meta } = cacheado;
    const page = clampPage(args.page);
    const pageSize = clampPageSize(args.pageSize);
    const inicio = (page - 1) * pageSize;
    const items = agregado.slice(inicio, inicio + pageSize);
    const somar = (campo: string) =>
      agregado.reduce((s, l) => s + num(l[campo]), 0);

    return {
      ok: true,
      status: 200,
      data: {
        items,
        count: items.length,
        page,
        pageSize,
        total: agregado.length,
        totalPages: Math.ceil(agregado.length / pageSize) || 0,
        totalizer: {
          VALOR_FATURADO: arredondar(somar('VALOR_FATURADO')),
          VALOR_LUCRO: arredondar(somar('VALOR_LUCRO')),
          QT_PEDIDOS: somar('QT_PEDIDOS'),
        },
        filiaisAplicadas: (filtros.listaFilial as string[] | undefined)?.map(
          String,
        ),
        fonte: 'agregado-em-processo',
        agrupadoPor: 'cliente',
        varredura: meta,
        ...(meta.acimaDoTeto
          ? {
              hint: `Consulta ampla demais para agregar: ${meta.totalUpstream ?? '?'} pedidos (teto ${MAX_SCAN_PEDIDOS}). Nada foi somado — um ranking sobre parte da base seria enganoso. Informe listaFilial (uma filial costuma ficar na casa das centenas) ou use um periodo mais curto.`,
            }
          : !meta.completa
            ? {
                hint: `Varredura parcial: ${meta.pedidos} de ${meta.totalUpstream ?? '?'} pedidos${meta.motivo ? ` (${meta.motivo})` : ''}. Os valores são de uma amostra — restrinja periodo ou listaFilial.`,
              }
            : {}),
      },
    };
  }

  /**
   * Agrega por uma dimensão enumerável **sem varrer linha nenhuma**.
   *
   * `paginator.count` e `totalizer` são do conjunto filtrado inteiro, não da
   * página (count: PROVADO no contrato §1.4; totalizer: inferido e conferido em
   * runtime abaixo). Então uma chamada por valor com `countDataPage: "1"` já
   * traz a contagem e as somas daquele valor. 20 filiais ≈ 20 chamadas ≈ 5s.
   */
  private async agregarPorDimensao(
    dimensao: DimensaoEnumeravel,
    filtrosBase: Filtros,
    paginacao: Paginacao,
    solicitado: Dimensao,
    totalUpstreamCliente?: number,
  ): Promise<WinthorApiResult<GridResult>> {
    const cfg = DIMENSOES[dimensao];
    const base = this.chaveConfig();
    const chave = base
      ? `${base}|fatPorDim|v1|${dimensao}|${chaveEstavel(filtrosBase)}`
      : '';

    const falhas: WinthorApiResult<unknown>[] = [];
    const cacheado = (await this.listCache.getOrLoad(chave, async () => {
      const valores = await this.enumerarDimensao(dimensao, filtrosBase);
      if (!valores.ok) {
        falhas.push(valores.erro);
        return null;
      }

      const linhas: LinhaFaturamento[] = [];
      let somaCount = 0;
      let somaValor = 0;
      let custoDisponivel = true;

      // Sequencial de propósito: o WinthorApiService reusa uma sessão, e se o
      // ERP amarrar estado de query a ela, chamadas concorrentes podem
      // contaminar o totalizer — bug de número errado, não de lentidão.
      for (const valor of valores.valores) {
        const totais = await this.chamarTotais({
          ...filtrosBase,
          [cfg.chaveFiltro]: [valor.codigo],
        });
        // Uma chamada perdida encolheria o total em silêncio.
        if (!totais.ok) {
          falhas.push(totais.erro);
          return null;
        }
        if (totais.count === 0) continue;

        const faturado = metricaNumerica(totais.totalizer, 'VALOR_PEDIDO');
        const custo = metricaNumerica(totais.totalizer, 'CUSTO_FINANCEIRO');
        if (custo === undefined) custoDisponivel = false;

        somaCount += totais.count;
        somaValor += faturado ?? 0;

        linhas.push({
          NIVEL: dimensao,
          [cfg.chaveCodigo]: valor.codigo,
          [cfg.chaveNome]:
            valor.nome ?? totais.amostra[cfg.campoNomeNaLinha] ?? '',
          QT_PEDIDOS: totais.count,
          ...(faturado !== undefined
            ? { VALOR_FATURADO: arredondar(faturado) }
            : {}),
          ...(faturado !== undefined && custo !== undefined
            ? {
                CUSTO_FINANCEIRO: arredondar(custo),
                VALOR_LUCRO: arredondar(faturado - custo),
                PERC_LUCRO: faturado
                  ? arredondar(((faturado - custo) / faturado) * 100)
                  : 0,
              }
            : {}),
        });
      }

      // Conferência: uma chamada com o filtro da união. Pega de uma vez
      // totalizer com escopo de página, valor que sumiu e dupla contagem.
      const geral = await this.chamarTotais(filtrosBase);
      if (!geral.ok) {
        falhas.push(geral.erro);
        return null;
      }
      const totalGeral = metricaNumerica(geral.totalizer, 'VALOR_PEDIDO');
      const divergenciaPct =
        totalGeral && totalGeral !== 0
          ? arredondar(((somaValor - totalGeral) / totalGeral) * 100)
          : somaValor === 0
            ? 0
            : 100;

      // Sem totalizer no conjunto não há o que conferir — e alegar que fecha
      // seria pior que admitir que só a contagem é confiável.
      const confere =
        totalGeral !== undefined &&
        Math.abs(divergenciaPct) <= TOLERANCIA_CONFERENCIA_PCT;
      if (!confere) {
        this.logger.error(
          `conferência falhou em ${dimensao}: soma ${somaValor} vs total ${String(totalGeral)} (${divergenciaPct}%) — totalizer pode não ser do conjunto inteiro.`,
        );
      }

      for (const linha of linhas) {
        // Só derruba o dinheiro; QT_PEDIDOS vem de paginator.count, que é
        // provado, então a contagem sobrevive à queda da hipótese.
        if (!confere) {
          delete linha.VALOR_FATURADO;
          delete linha.CUSTO_FINANCEIRO;
          delete linha.VALOR_LUCRO;
          delete linha.PERC_LUCRO;
        } else if (somaValor) {
          linha.PARTICIPACAO = arredondar(
            (num(linha.VALOR_FATURADO) / somaValor) * 100,
          );
        }
      }

      linhas.sort((a, b) =>
        confere
          ? num(b.VALOR_FATURADO) - num(a.VALOR_FATURADO)
          : num(b.QT_PEDIDOS) - num(a.QT_PEDIDOS),
      );

      const valor: AgregadoDimensao = {
        linhas,
        conferencia: {
          somaDimensao: arredondar(somaValor),
          totalGeral: totalGeral ?? null,
          divergenciaPct,
          confere,
        },
        somaCount,
        countGeral: geral.count,
        custoDisponivel: custoDisponivel && confere,
      };
      return { valor, chars: estimarChars(linhas) };
    })) as AgregadoDimensao | null;

    if (cacheado === null) {
      const falha = falhas[0];
      return {
        ok: false,
        status: falha?.status ?? 0,
        error: falha?.error ?? `Falha ao agregar por ${dimensao}.`,
        raw: falha?.raw,
      };
    }

    const page = clampPage(paginacao.page);
    const pageSize = clampPageSize(paginacao.pageSize);
    const inicio = (page - 1) * pageSize;
    const items = cacheado.linhas.slice(inicio, inicio + pageSize);
    const rebaixado = solicitado !== dimensao;

    const avisos: string[] = [];
    if (rebaixado) {
      avisos.push(
        `${totalUpstreamCliente ?? '?'} pedidos: agregar por ${solicitado} exigiria varredura (teto ${MAX_SCAN_PEDIDOS}). Agrupei por ${dimensao} — exato, sem varredura. Para ${solicitado}, informe listaFilial ou reduza o periodo.`,
      );
    }
    if (!cacheado.conferencia.confere) {
      avisos.push(
        `Conferência falhou (${cacheado.conferencia.divergenciaPct}% de divergência): os valores somados não batem com o total do conjunto, então só QT_PEDIDOS foi mantido.`,
      );
    } else if (!cacheado.custoDisponivel) {
      avisos.push(
        'O upstream não devolveu CUSTO_FINANCEIRO totalizado; lucro e margem ficaram de fora.',
      );
    }

    return {
      ok: true,
      status: 200,
      data: {
        items,
        count: items.length,
        page,
        pageSize,
        total: cacheado.linhas.length,
        totalPages: Math.ceil(cacheado.linhas.length / pageSize) || 0,
        totalizer: {
          QT_PEDIDOS: cacheado.somaCount,
          ...(cacheado.conferencia.confere
            ? { VALOR_FATURADO: cacheado.conferencia.somaDimensao }
            : {}),
        },
        filiaisAplicadas: (
          filtrosBase.listaFilial as string[] | undefined
        )?.map(String),
        fonte: 'agregado-em-processo',
        agrupadoPor: dimensao,
        ...(rebaixado
          ? { agrupamentoSolicitado: solicitado, rebaixado: true }
          : {}),
        conferencia: cacheado.conferencia,
        metricas: cacheado.conferencia.confere
          ? cacheado.custoDisponivel
            ? ['QT_PEDIDOS', 'VALOR_FATURADO', 'VALOR_LUCRO', 'PERC_LUCRO']
            : ['QT_PEDIDOS', 'VALOR_FATURADO']
          : ['QT_PEDIDOS'],
        ...(avisos.length ? { hint: avisos.join(' ') } : {}),
      },
    };
  }

  /** Uma chamada de 1 linha só para ler `paginator.count` e `totalizer`. */
  private async chamarTotais(filtros: Filtros): Promise<
    | { ok: false; erro: WinthorApiResult<unknown> }
    | {
        ok: true;
        count: number;
        totalizer: Record<string, unknown>;
        amostra: Record<string, unknown>;
      }
  > {
    const r = await this.grid(
      ENDPOINTS.pedidosDeVenda,
      [...COLUNAS_FATURAMENTO],
      filtros,
      { page: 1, pageSize: 1 },
    );
    if (!r.ok) return { ok: false, erro: r };
    return {
      ok: true,
      count: r.data?.total ?? 0,
      totalizer: r.data?.totalizer ?? {},
      amostra: r.data?.items[0] ?? {},
    };
  }

  /** Valores da dimensão. Filiais já vêm resolvidas no filtro base. */
  private async enumerarDimensao(
    dimensao: DimensaoEnumeravel,
    filtrosBase: Filtros,
  ): Promise<
    | { ok: false; erro: WinthorApiResult<unknown> }
    | { ok: true; valores: { codigo: string; nome?: string }[] }
  > {
    if (dimensao === 'filial') {
      const codigos = (filtrosBase.listaFilial as string[] | undefined) ?? [];
      return { ok: true, valores: codigos.map((codigo) => ({ codigo })) };
    }

    const r = await this.pesquisar(
      ENDPOINTS.lucratividadePesquisarSupervisor,
      [col('CODIGO'), col('NOME')],
      'codigoSupervisor',
      '',
      { page: 1, pageSize: 200 },
    );
    if (!r.ok) return { ok: false, erro: r };

    return {
      ok: true,
      valores: (r.data?.items ?? [])
        .map((linha) => ({
          codigo: chaveDe(linha.CODIGO),
          nome: chaveDe(linha.NOME),
        }))
        .filter((v) => v.codigo !== ''),
    };
  }

  /** Percorre todas as páginas de listarPedidosDeVenda dentro do teto. */
  private async varrerPedidos(filtros: Filtros): Promise<
    | { ok: false; erro: WinthorApiResult<unknown> }
    | {
        ok: true;
        pedidos: Record<string, unknown>[];
        varredura: Varredura;
      }
  > {
    const pedidos: Record<string, unknown>[] = [];
    const vistos = new Set<string>();
    let paginas = 0;
    let totalUpstream: number | undefined;
    let completa = false;
    let acimaDoTeto = false;
    let motivo: string | undefined;

    for (let page = 1; ; page++) {
      const resposta = await this.grid(
        ENDPOINTS.pedidosDeVenda,
        [...COLUNAS_FATURAMENTO],
        filtros,
        { page, pageSize: SCAN_PAGE_SIZE },
      );
      if (!resposta.ok) return { ok: false, erro: resposta };

      paginas++;
      const lote = resposta.data?.items ?? [];
      totalUpstream = resposta.data?.total ?? totalUpstream;

      if (lote.length === 0) {
        completa = true;
        break;
      }

      // A semântica de página do upstream nunca foi verificada (o contrato só
      // capturou page=1). Se um lote não traz nada novo, a paginação não está
      // avançando — parar é a única saída segura contra laço infinito.
      const antes = vistos.size;
      for (const pedido of lote) {
        const id = chaveDe(pedido.NUMERO_PEDIDO) || JSON.stringify(pedido);
        if (vistos.has(id)) continue;
        vistos.add(id);
        pedidos.push(pedido);
      }
      if (vistos.size === antes) {
        motivo = 'upstream repetiu a página; paginação não avançou';
        break;
      }

      if (totalUpstream !== undefined && pedidos.length >= totalUpstream) {
        completa = true;
        break;
      }

      // O upstream informa o total já na primeira página. Se ele passa do
      // teto, varrer até o teto produziria um ranking sobre um subconjunto
      // arbitrário do início da lista — resposta errada com aviso, não amostra.
      // Melhor parar aqui: custa uma chamada e devolve o remédio exato.
      if (totalUpstream !== undefined && totalUpstream > MAX_SCAN_PEDIDOS) {
        acimaDoTeto = true;
        motivo = `${totalUpstream} pedidos, acima do teto de ${MAX_SCAN_PEDIDOS}`;
        break;
      }
      if (pedidos.length >= MAX_SCAN_PEDIDOS) {
        motivo = `teto de ${MAX_SCAN_PEDIDOS} pedidos`;
        break;
      }
      if (lote.length < SCAN_PAGE_SIZE) {
        // Página curta normalmente é o fim. Mas se o upstream declarou um total
        // maior, ele não honrou countDataPage — encerrar como "completa" aqui
        // publicaria um agregado incompleto se dizendo completo.
        if (totalUpstream !== undefined && pedidos.length < totalUpstream) {
          motivo = `página curta (${lote.length} linhas) com ${totalUpstream} disponíveis: countDataPage não honrado`;
        } else {
          completa = true;
        }
        break;
      }
    }

    if (!completa && motivo) {
      this.logger.warn(`agregação parcial: ${motivo}`);
    }

    return {
      ok: true,
      pedidos,
      varredura: {
        pedidos: pedidos.length,
        paginas,
        completa,
        totalUpstream,
        ...(acimaDoTeto ? { acimaDoTeto: true } : {}),
        ...(motivo ? { motivo } : {}),
      },
    };
  }

  /** Soma os pedidos por cliente e ordena por valor faturado. */
  private somarPorCliente(
    pedidos: Record<string, unknown>[],
  ): LinhaFaturamento[] {
    const porCliente = new Map<string, LinhaFaturamento>();

    for (const pedido of pedidos) {
      const codigo = chaveDe(pedido.CODIGO_CLIENTE);
      if (!codigo) continue;

      const atual = porCliente.get(codigo) ?? {
        CODIGO_CLIENTE: pedido.CODIGO_CLIENTE,
        NOME_CLIENTE: pedido.NOME_CLIENTE ?? '',
        QT_PEDIDOS: 0,
        VALOR_FATURADO: 0,
        CUSTO_FINANCEIRO: 0,
        VALOR_LUCRO: 0,
        PERC_LUCRO: 0,
        PARTICIPACAO: 0,
      };

      atual.QT_PEDIDOS = (atual.QT_PEDIDOS as number) + 1;
      atual.VALOR_FATURADO =
        (atual.VALOR_FATURADO as number) + num(pedido.VALOR_PEDIDO);
      atual.CUSTO_FINANCEIRO =
        (atual.CUSTO_FINANCEIRO as number) + num(pedido.CUSTO_FINANCEIRO);
      porCliente.set(codigo, atual);
    }

    // Lucro, margem e participação vêm de `finalizarLinhas`, a mesma função que a
    // base local usa: um número, uma implementação.
    const linhas = finalizarLinhas([...porCliente.values()], {
      custoDisponivel: true,
    });

    return linhas.sort(
      (a, b) => (b.VALOR_FATURADO as number) - (a.VALOR_FATURADO as number),
    );
  }

  /**
   * Drill-down de um pedido (§4.5). A grade reenvia o registro inteiro, mas o
   * backend consome apenas codigoPedido, nomeFilial e listaFilial.
   */
  async listarDetalhePedido(
    endpoint: string,
    colunas: ColunaGrid[],
    args: {
      codigoPedido: string;
      nomeFilial: string;
      listaFilial?: string[];
      periodo?: PeriodoCodigo;
      posicaoPedido?: string;
    } & Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    const filtros = await this.filtrosLucratividade({
      ...args,
      perspectiva: '1',
    });
    return this.grid(
      endpoint,
      colunas,
      {
        ...filtros,
        codigoPedido: String(args.codigoPedido),
        nomeFilial: args.nomeFilial,
        NUMERO_PEDIDO: String(args.codigoPedido),
      },
      args,
    );
  }

  // -------------------------------------------------------------------------
  // Lookups (§3.5 e §4.6)
  // -------------------------------------------------------------------------

  /**
   * Modais de pesquisa. A chave do filtro muda por endpoint — `CODIGO` em
   * maiúsculas para tipo de cobrança, `codigoRCA` com sigla maiúscula para RCA.
   */
  async pesquisar(
    endpoint: string,
    colunas: ColunaGrid[],
    chaveFiltro: string,
    termo: string | undefined,
    paginacao?: Paginacao,
  ): Promise<WinthorApiResult<GridResult>> {
    return this.grid(
      endpoint,
      colunas,
      { [chaveFiltro]: termo ?? '' },
      paginacao,
    );
  }
}
