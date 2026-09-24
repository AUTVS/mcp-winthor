/**
 * Limites de payload, paginação e rede.
 *
 * Constantes de módulo em vez de service injetável: virar dependência de DI
 * mudaria a assinatura de WinthorMobileService e quebraria todos os specs que
 * a instanciam à mão, sem ganho real. Override por variável de ambiente cobre
 * a tunagem em produção sem rebuild.
 */

const env = (chave: string, padrao: number): number =>
  Number(process.env[chave]) || padrao;

/** Itens por página quando o caller não informa. */
export const PAGE_SIZE_DEFAULT = env('WTA_DEFAULT_PAGE_SIZE', 10);

/** Teto de itens por página, mesmo se o caller pedir mais. */
export const PAGE_SIZE_MAX = env('WTA_MAX_PAGE_SIZE', 200);

/**
 * Orçamento de caracteres do texto devolvido por uma tool MCP.
 *
 * É a entrada de todos os caps de paginação (`mcp/tools/pagination.ts`), que
 * dividem este valor pela largura declarada da linha. Mudar isto muda todo cap
 * e, com ele, o sistema de coordenadas das páginas — só tem efeito no próximo
 * start, o que é o desejado.
 *
 * No caminho paginado o truncamento de `tool-result.ts` nunca deveria disparar;
 * se disparar, é cap mal dimensionado e sai um `logger.error`.
 */
export const MAX_RESULT_CHARS = env('WTA_MAX_RESULT_CHARS', 80_000);

/** Timeout de cada chamada HTTP ao WinThor. */
export const REQUEST_TIMEOUT_MS = env('WTA_HTTP_TIMEOUT_MS', 20_000);

/** Teto de bytes lidos do corpo de uma resposta do WinThor. */
export const MAX_UPSTREAM_BYTES = env('WTA_MAX_UPSTREAM_BYTES', 8_000_000);

/**
 * Janela em que o token é reusado sem reconfirmar em /logado. Token expirado
 * dentro da janela cai no retry de 401 do WinthorApiService.
 */
export const TOKEN_PROBE_TTL_MS = env('WTA_TOKEN_PROBE_TTL_MS', 10 * 60_000);

/**
 * Validade das listas completas cacheadas (clientes, filiais).
 *
 * 2 min: um assistente percorre páginas em segundos a poucos minutos; passado
 * isso a "sessão" acabou e refazer a busca é o padrão certo.
 */
export const LIST_CACHE_TTL_MS = env('WTA_LIST_CACHE_TTL_MS', 120_000);

export const LIST_CACHE_MAX_ENTRIES = env('WTA_LIST_CACHE_MAX_ENTRIES', 8);

/**
 * 2× MAX_UPSTREAM_BYTES — "no máximo duas respostas de pior caso residentes".
 * Importa mais que o normal: o servidor roda embutido num Electron de vida
 * longa, não num contêiner reiniciável.
 */
export const LIST_CACHE_MAX_CHARS = env('WTA_LIST_CACHE_MAX_CHARS', 16_000_000);

/**
 * Tamanho de página das varreduras internas de agregação.
 *
 * Não é o `pageSize` da tool: aqui o servidor lê para si mesmo, sem o modelo no
 * meio, então vale pedir páginas grandes. Se o upstream não honrar, a guarda de
 * linhas repetidas na varredura interrompe.
 */
export const SCAN_PAGE_SIZE = env('WTA_SCAN_PAGE_SIZE', 200);

/**
 * Teto de pedidos varridos numa agregação.
 *
 * Dimensionado com número real: uma página de 200 pedidos leva ~2,9 s no
 * WinThor medido, então 3.000 pedidos ≈ 15 páginas ≈ 45 s de espera — o
 * máximo tolerável numa chamada de tool. Para referência, "mês atual, 20
 * filiais, faturado" dá 13.499 pedidos: acima do teto, e a agregação recusa
 * em vez de varrer (ver `agregarFaturamentoPorCliente`).
 */
export const MAX_SCAN_PEDIDOS = env('WTA_MAX_SCAN_PEDIDOS', 3_000);

/**
 * Margem aceita entre uma soma feita aqui e o total declarado pelo WinThor.
 *
 * Meio ponto percentual cobre arredondamento do ERP, não erro de agregação.
 * Morava privada em `winthor-mobile.service.ts`; subiu para cá quando a base
 * local passou a conferir pelo mesmo critério — dois números para a mesma régua
 * é como as duas rotas passariam a discordar sobre o que "fecha" significa.
 */
export const TOLERANCIA_CONFERENCIA_PCT = Number(
  process.env.WTA_TOLERANCIA_CONFERENCIA_PCT ?? 0.5,
);

/**
 * Itens por página das varreduras de ingestão da base local.
 *
 * Nasce em 100 (não 200): em período anual (`7`/`8`) o W106 devolve o pedido
 * completo (§6.8) e 200 linhas estouram `MAX_UPSTREAM_BYTES` com frequência.
 * A ingestão ainda reduz o pageSize automaticamente se o payload vier grande.
 */
export const INGESTAO_PAGE_SIZE = env('WTA_INGESTAO_PAGE_SIZE', 100);

/**
 * Piso do pageSize adaptativo da ingestão. Abaixo disso, estouro de payload
 * vira falha do lote — páginas menores que isto multiplicam demais as idas ao ERP.
 */
export const INGESTAO_PAGE_SIZE_MIN = env('WTA_INGESTAO_PAGE_SIZE_MIN', 25);

/** Tentativas extras em timeout / fetch failed antes de falhar o lote. */
export const INGESTAO_RETRY_MAX = env('WTA_INGESTAO_RETRY_MAX', 3);

/**
 * Pausa entre páginas da ingestão, e a pausa maior enquanto há tool call em voo.
 *
 * O backfill leva perto de duas horas; o usuário não pode esperar atrás dele.
 */
export const INGESTAO_PAUSA_MS = env('WTA_INGESTAO_PAUSA_MS', 250);
export const INGESTAO_PAUSA_OCUPADO_MS = env(
  'WTA_INGESTAO_PAUSA_OCUPADO_MS',
  3_000,
);

/**
 * Sincronização automática em segundo plano.
 *
 * `INGESTAO_INTERVALO_MS` é de quanto em quanto tempo o servidor **verifica** se
 * a atualização está vencida — não de quanto em quanto tempo ele varre. Um
 * gatilho em hora fixa nunca dispararia num notebook fechado às 3h; comparar
 * contra a idade da cobertura dispara na primeira vez que a máquina acorda.
 */
export const INGESTAO_AUTO = (process.env.WTA_INGESTAO_AUTO ?? '1') !== '0';
export const INGESTAO_INTERVALO_MS = env(
  'WTA_INGESTAO_INTERVALO_MS',
  30 * 60_000,
);

/** Idade a partir da qual a janela quente é revarrida. */
export const INGESTAO_VALIDADE_MS = env(
  'WTA_INGESTAO_VALIDADE_MS',
  20 * 60 * 60_000,
);

/** Anos de histórico mantidos: ano atual + N-1 anteriores. */
export const RETENCAO_ANOS = env('WTA_RETENCAO_ANOS', 2);

export const clampPage = (page?: number): number =>
  Math.max(1, Math.trunc(page ?? 1));

export const clampPageSize = (pageSize?: number): number =>
  Math.min(
    Math.max(1, Math.trunc(pageSize ?? PAGE_SIZE_DEFAULT)),
    PAGE_SIZE_MAX,
  );
