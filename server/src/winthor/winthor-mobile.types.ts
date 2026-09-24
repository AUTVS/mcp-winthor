/**
 * Tipos e constantes das rotinas mobile do WinThor Anywhere (W120 e W106).
 * Contrato levantado em docs/api-winthor-mobile-rotinas-120-106.md.
 */

export const MOBILE_BASE = '/winthor/mobile/v2';

/** Códigos de período compartilhados pelas duas rotinas (§1.5). */
export const PERIODOS = {
  '1': 'Hoje',
  '2': 'Ontem',
  '3': 'Mês atual',
  '4': 'Mês anterior',
  '7': 'Ano atual',
  '8': 'Ano anterior',
} as const;

export type PeriodoCodigo = keyof typeof PERIODOS;
export const PERIODO_PADRAO: PeriodoCodigo = '3';

/** Posições de pedido da rotina W106 (§4.3). */
export const POSICOES_PEDIDO = {
  '0': 'Todos',
  '1': 'Bloqueado',
  '2': 'Pendente',
  '3': 'Liberado',
  '4': 'Faturado',
} as const;

export type PosicaoPedidoCodigo = keyof typeof POSICOES_PEDIDO;

/**
 * Caminhos dos endpoints.
 *
 * ATENÇÃO: três nomes contêm erros de grafia que fazem parte do contrato do
 * servidor e devem ser reproduzidos literalmente (§6.1):
 *   - listarResumoIndimplenciaPorCliente     (falta o "a" em Inadimplencia)
 *   - listarResumoInadimpleciaPorSupervisor  (falta o "n" em Inadimplencia)
 *   - listarResumoIndimplenciaPorDiaAtrazo   (falta o "a" e usa "z" em Atraso)
 * Corrigi-los quebra a chamada.
 */
export const ENDPOINTS = {
  usuarioLogado: 'controleAcesso/buscarUsuarioLogado',
  pesquisarFilial: 'boletimFinanceiro/pesquisarFilial',

  inadimplenciaPorFilial:
    'resumoInadimplencia/listarResumoInadimplenciaPorFilial',
  inadimplenciaPorCliente:
    'resumoInadimplencia/listarResumoIndimplenciaPorCliente',
  inadimplenciaPorSupervisor:
    'resumoInadimplencia/listarResumoInadimpleciaPorSupervisor',
  inadimplenciaPorRamoAtividade:
    'resumoInadimplencia/listarResumoInadimplenciaPorRamoAtividade',
  inadimplenciaPorCobranca:
    'resumoInadimplencia/listarResumoInadimplenciaPorCobranca',
  inadimplenciaPorDiaAtraso:
    'resumoInadimplencia/listarResumoIndimplenciaPorDiaAtrazo',
  inadimplenciaPorValor:
    'resumoInadimplencia/listarResumoInadimplenciaPorValor',
  valorCarteira: 'resumoInadimplencia/consultarValorCarteira',
  inadimplenciaPesquisarSupervisor: 'resumoInadimplencia/pesquisarSupervisor',
  inadimplenciaPesquisarCliente: 'resumoInadimplencia/pesquisarCliente',
  inadimplenciaPesquisarTipoCobranca:
    'resumoInadimplencia/pesquisarTipoCobranca',

  pedidosDeVenda: 'lucratividade/listarPedidosDeVenda',
  lucratividadePorRca: 'lucratividade/listarLucratividadeSinteticaPorRCA',
  itensPedidoDeVenda: 'lucratividade/listarItensPedidoDeVenda',
  faltasPedidoDeVenda: 'lucratividade/listarFaltasPedidoDeVenda',
  lucratividadePesquisarCliente: 'lucratividade/pesquisarCliente',
  lucratividadePesquisarEmitente: 'lucratividade/pesquisarEmitente',
  lucratividadePesquisarSupervisor: 'lucratividade/pesquisarSupervisor',
  lucratividadePesquisarRca: 'lucratividade/pesquisarRca',
} as const;

/** Coluna do envelope de requisição (§1.3). */
export interface ColunaGrid {
  columnName: string;
  totalized: boolean;
  order: null;
}

/** Helper de declaração de coluna: `col('VALOR', true)` marca para totalização. */
export function col(columnName: string, totalized = false): ColunaGrid {
  return { columnName, totalized, order: null };
}

export type Filtros = Record<string, unknown>;

/**
 * Converte para o código em string que o WinThor exige, ou null se o valor não
 * for escalar. Códigos, matrículas e períodos viajam sempre como string (§6.4).
 */
export function toCodigo(valor: unknown): string | null {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : null;
}

interface GridItem {
  data?: Record<string, unknown>;
  dataModel?: Record<string, unknown>;
  keySet?: string[];
  empty?: boolean;
  type?: string;
}

export interface GridResponse {
  data?: { list?: GridItem[] };
  paginator?: {
    nextPage?: string;
    countDataPage?: string;
    paginator?: boolean;
    count?: number;
  };
  totalizer?: Record<string, number> | null;
}

export interface DataModelResponse {
  data?: Record<string, unknown>;
  dataModel?: Record<string, unknown>;
  keySet?: string[];
  empty?: boolean;
  type?: string;
}

/** Retorno achatado que as tools entregam ao assistente. */
export interface GridResult {
  items: Record<string, unknown>[];
  count: number;
  page: number;
  pageSize: number;
  total?: number;
  totalPages?: number;
  totalizer?: Record<string, number>;
  /** Filiais efetivamente consultadas — úteis quando foram resolvidas sozinhas. */
  filiaisAplicadas?: string[];
  /** Aviso para o assistente (ex.: consulta expandida para muitas filiais). */
  hint?: string;
  /** Quando a lista veio do cache, em ISO. */
  cachedAt?: string;
  /**
   * `agregado-em-processo` quando os números foram somados aqui, e não pelo
   * WinThor — o assistente precisa saber que a origem não é o ERP.
   */
  fonte?: string;
  /** Dimensão em que as linhas estão agrupadas. */
  agrupadoPor?: string;
  /** Dimensão originalmente pedida, quando houve rebaixamento. */
  agrupamentoSolicitado?: string;
  /** `true` quando a agregação caiu para uma dimensão mais grossa. */
  rebaixado?: boolean;
  /** Métricas efetivamente presentes nas linhas. */
  metricas?: string[];
  /** Soma por dimensão vs. total do conjunto — prova de que os números fecham. */
  conferencia?: {
    somaDimensao: number;
    totalGeral: number | null;
    divergenciaPct: number;
    confere: boolean;
  };
  /** Cobertura da varredura que alimentou uma agregação. */
  varredura?: {
    pedidos: number;
    paginas: number;
    completa: boolean;
    totalUpstream?: number;
    motivo?: string;
    acimaDoTeto?: boolean;
  };
}
