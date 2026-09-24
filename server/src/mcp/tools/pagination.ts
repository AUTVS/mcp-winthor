import { Logger } from '@nestjs/common';
import {
  clampPage,
  clampPageSize,
  MAX_RESULT_CHARS,
  PAGE_SIZE_MAX,
} from '../../config/limits';
import { findRowKey, shapeToolResult, ToolResult } from './tool-result';

/**
 * Paginação garantida — o middleware das tools MCP.
 *
 * O tamanho da página é decidido **antes** da chamada upstream, cabe no
 * orçamento por construção, e é ecoado de volta. Nenhuma linha se torna
 * inalcançável.
 *
 * O desenho anterior cortava linhas depois da chamada e deixava `page`/
 * `pageSize` intactos: pedir 200, receber 110 e então pedir `page=2` fazia o
 * upstream devolver as linhas 201-400 — as linhas 111-200 sumiam. Truncamento e
 * paginação upstream usam sistemas de coordenadas incompatíveis.
 */

const logger = new Logger('Paginacao');

export type LarguraLinha = 'estreita' | 'media' | 'larga' | 'enorme';

/**
 * Teto de chars por linha, não média: o cap é orçamento/teto. Subestimar aqui
 * é bug — dispara o truncamento de emergência, que é ruidoso de propósito.
 *
 * NÃO derivar isto de `COLUNAS[x].length`: o backend ignora `data.list` no
 * SELECT (contrato §6.8), que é exatamente por que `listarPedidosDeVenda`
 * devolve 28 campos para 9 colunas pedidas. Contagem de coluna não prevê
 * largura de linha; só resposta observada prevê.
 *
 * Calibrado contra o WinThor real (`npm run probe:pagination`, 2026-07-25),
 * p95 medido por classe:
 *   estreita — lookups 49-107, resumos W120 91-244, por-RCA 177
 *   larga    — listarPedidosDeVenda 727 (máx 743)
 *   enorme   — não medido: registro de cliente do REST, mantido conservador
 */
const CHARS_POR_LINHA: Record<LarguraLinha, number> = {
  estreita: 300,
  media: 500,
  larga: 800,
  enorme: 3_000,
};

/** Cabeçalho do envelope + totalizer + filiaisAplicadas + hints compostos. */
const RESERVA_ENVELOPE = 2_000;

/**
 * Padrão para tool nova ou não classificada. Conservador de propósito: quem
 * esquecer de classificar ganha um cap pequeno e nunca dispara o alarme.
 */
export const LARGURA_PADRAO: LarguraLinha = 'larga';

/**
 * Cap por classe. Com os 80.000 chars padrão:
 * estreita 200 · media 150 · larga 60 · enorme 20.
 *
 * O arredondamento para múltiplo de 10 existe só para o número ecoado e o texto
 * do hint ficarem legíveis; custa no máximo 9 linhas por página.
 */
export function capParaLargura(largura: LarguraLinha): number {
  const cabem =
    (MAX_RESULT_CHARS - RESERVA_ENVELOPE) / CHARS_POR_LINHA[largura];
  return Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(cabem / 10) * 10));
}

/** Texto único das quatro descrições de `pageSize`, para não divergirem. */
export const DESCRICAO_PAGE_SIZE =
  'Itens por página. Pode ser reduzido automaticamente quando as linhas são largas; a resposta traz o `pageSize` efetivo — use esse valor nas páginas seguintes.';

export type DecisaoPaginacao =
  | { paginar: false }
  | {
      paginar: true;
      page: number;
      efetivo: number;
      solicitado: number;
      reduzido: boolean;
      args: Record<string, unknown>;
    };

/**
 * Decide a página. Função **pura de `(largura, page, pageSize solicitado)`** —
 * nunca de estado aprendido em runtime. É essa pureza que mantém as coordenadas
 * estáveis: pedir 200 devolve `pageSize: 60`, e a chamada seguinte com 60
 * devolve 60 de novo. Um cap derivado de largura observada derivaria entre
 * chamadas e recriaria o bug das linhas inalcançáveis.
 */
export function decidirPagina(
  args: Record<string, unknown>,
  largura: LarguraLinha,
): DecisaoPaginacao {
  // Espelha o predicado do próprio serviço: com ambos omitidos,
  // `wt_mobile_pesquisar_filial` devolve a lista inteira de propósito, porque
  // `filiaisPadrao()` deriva `listaFilial` dela.
  const paginar = args.page !== undefined || args.pageSize !== undefined;
  if (!paginar) return { paginar: false };

  const solicitado = clampPageSize(args.pageSize as number | undefined);
  const efetivo = Math.min(solicitado, capParaLargura(largura));
  const page = clampPage(args.page as number | undefined);

  return {
    paginar: true,
    page,
    efetivo,
    solicitado,
    reduzido: efetivo < solicitado,
    args: { ...args, page, pageSize: efetivo },
  };
}

type Payload = Record<string, unknown>;

function compor(...partes: (string | undefined)[]): string {
  return partes.filter(Boolean).join(' ');
}

/**
 * Completa o envelope de paginação sobre o resultado que o handler produziu.
 *
 * Faz parse, decora e **re-executa `shapeToolResult`**, para o invariante de
 * ≤ MAX_RESULT_CHARS cobrir também os ~120 chars que a decoração acrescenta.
 * A alternativa (contexto de paginação em módulo lido por `shapeToolResult`)
 * seria insegura sob chamadas concorrentes e exigiria AsyncLocalStorage sem
 * ganho nenhum. O parse/stringify extra custa ~1 ms em ≤80 KB, contra chamadas
 * HTTP com timeout de 20 s — não vale virar global para "otimizar".
 */
export function decorar(
  resultado: ToolResult,
  decisao: Extract<DecisaoPaginacao, { paginar: true }>,
  toolName: string,
): ToolResult {
  if (resultado.isError) return resultado;

  let parsed: Payload;
  try {
    parsed = JSON.parse(resultado.content[0].text) as Payload;
  } catch {
    return resultado;
  }

  if (parsed.ok !== true) return resultado;

  const rowKey = findRowKey(parsed);
  if (!rowKey) return resultado;

  const linhas = parsed[rowKey] as unknown[];

  // Impossível se o upstream honrou `countDataPage`. Quando acontece, aquele
  // endpoint ignora o bloco `paginator` — suposição não testada virando alarme.
  if (linhas.length > decisao.efetivo) {
    logger.warn(
      `${toolName}: upstream devolveu ${linhas.length} linhas para countDataPage=${decisao.efetivo} — endpoint parece ignorar o paginador.`,
    );
  }

  const hasMore = calcularHasMore(parsed, linhas.length, decisao);

  const decorado: Payload = {
    ...parsed,
    // Sobrescritos pela decisão, não confiados do envelope.
    page: decisao.page,
    pageSize: decisao.efetivo,
    ...(decisao.reduzido ? { pageSizeSolicitado: decisao.solicitado } : {}),
    hasMore,
    // `null` explícito e não chave ausente: um leitor LLM distingue "não há
    // próxima" de "esqueceram de me dizer" com muito mais confiabilidade.
    nextPage: hasMore ? decisao.page + 1 : null,
  };

  if (decisao.reduzido) {
    decorado.hint = compor(
      `pageSize reduzido de ${decisao.solicitado} para ${decisao.efetivo}: as linhas desta rotina são largas. Use pageSize=${decisao.efetivo} nas próximas páginas.`,
      typeof parsed.hint === 'string' ? parsed.hint : undefined,
    );
  }

  const remoldado = shapeToolResult(decorado, false);

  const final = JSON.parse(remoldado.content[0].text) as Payload;
  if (final.truncated !== true) return remoldado;

  // Caminho de emergência: a largura declarada subestimou a realidade. No
  // caminho de sucesso isso é defeito, não condição normal — daí `error`.
  const observado = linhas.length
    ? Math.round(resultado.content[0].text.length / linhas.length)
    : 0;
  logger.error(
    `${toolName}: truncou mesmo paginado — cap=${decisao.efetivo}, ` +
      `mantidas=${String(final.returned)}/${linhas.length}, ` +
      `~${observado} chars/linha observados. Reclassifique a largura desta tool.`,
  );

  // Sem isso o bug original volta em miniatura: as linhas descartadas ficariam
  // entre esta página e a próxima. Mandar repetir a MESMA página.
  // Ambas as trocas são não-crescentes em bytes (page+1 → page; false → true),
  // então o orçamento já garantido continua valendo sem re-moldar.
  final.nextPage = decisao.page;
  final.hasMore = true;
  return {
    content: [{ type: 'text', text: JSON.stringify(final) }],
    isError: false,
  };
}

/**
 * Precedência estrita: sinal explícito do upstream > total exato > heurística.
 */
function calcularHasMore(
  parsed: Payload,
  recebidas: number,
  decisao: Extract<DecisaoPaginacao, { paginar: true }>,
): boolean {
  // 1. `wt_buscar_pedidos_venda` não tem `total`, mas o upstream responde a
  //    pergunta diretamente.
  if (typeof parsed.hasNext === 'boolean') return parsed.hasNext;

  // 2. Exato, quando o upstream mandou `paginator.count`.
  if (typeof parsed.total === 'number') {
    return decisao.page * decisao.efetivo < parsed.total;
  }

  // 3. Heurística. Falso positivo conhecido e aceito: uma última página que
  //    preenche exatamente `efetivo` reporta `hasMore: true` e a chamada
  //    seguinte volta vazia — custo de um round-trip. NÃO trocar por `>`: o
  //    viés oposto tornaria invisível o sucessor da última página parcial,
  //    recriando a classe de bug que este arquivo existe para matar.
  return recebidas >= decisao.efetivo;
}

type ConfigTool = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
};
type HandlerTool = (...args: unknown[]) => unknown;

/**
 * Uma tool é paginável quando o schema declara `page` E `pageSize`.
 *
 * Predicado e não blocklist de nomes: as 5 tools escalares são excluídas pelo
 * motivo certo. Também evita um perigo real — um handler registrado **sem**
 * `inputSchema` é chamado pelo SDK como `(ctx)`, com o ServerContext em arg0,
 * não os args. Embrulhar essas quebraria as 4 tools sem schema.
 */
export function temPaginacao(config?: ConfigTool): boolean {
  const schema = config?.inputSchema as
    { shape?: Record<string, unknown> } | undefined;
  const campos = schema?.shape ?? schema;
  return (
    !!campos &&
    typeof campos === 'object' &&
    'page' in campos &&
    'pageSize' in campos
  );
}

/**
 * Instala o middleware na instância do McpServer.
 *
 * Precisa rodar dentro de `create()` (o controller constrói um servidor novo
 * por handler). Remendar o protótipo seria global ao processo e vazaria entre
 * instâncias; remendar a instância tem o escopo certo. Os 27 registros passam
 * pela instância, inclusive os 21 do laço de `registerMobileTools`.
 */
export function instalarPaginacao(
  server: { registerTool: (...args: unknown[]) => unknown },
  larguras: Record<string, LarguraLinha>,
): void {
  // bind ANTES de sombrear: `registerTool` é método de protótipo e a
  // atribuição abaixo cria uma propriedade própria que o esconde.
  const original = server.registerTool.bind(server);

  const wrapper = (name: string, config: ConfigTool, cb: HandlerTool) => {
    // O objeto de config é repassado por referência, nunca modificado: baixar
    // o `.max()` anunciado transformaria pageSize=200 em erro de validação em
    // vez de redução graciosa, que é o oposto do desejado.
    if (!temPaginacao(config)) return original(name, config, cb);

    const largura = larguras[name] ?? LARGURA_PADRAO;

    const handler = async (
      args: Record<string, unknown> = {},
      ctx?: unknown,
    ) => {
      const decisao = decidirPagina(args ?? {}, largura);
      if (!decisao.paginar) {
        // Args intocados por referência — preserva o contrato "omitido = tudo".
        return (await cb(args, ctx)) as ToolResult;
      }
      const bruto = (await cb(decisao.args, ctx)) as ToolResult;
      return decorar(bruto, decisao, name);
    };

    return original(name, config, handler);
  };

  (server as { registerTool: unknown }).registerTool = wrapper;
}
