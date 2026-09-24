import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../../config/limits';
import { WinthorApiResult } from '../../winthor/winthor-api.service';
import { WinthorMobileService } from '../../winthor/winthor-mobile.service';
import {
  col,
  ENDPOINTS,
  PeriodoCodigo,
  toCodigo,
} from '../../winthor/winthor-mobile.types';
import {
  DESCRICAO_PAGE_SIZE,
  LARGURA_PADRAO,
  LarguraLinha,
} from './pagination';
import { toToolResult } from './tool-result';

/**
 * Tools das rotinas mobile W120 (Resumo de Inadimplência) e W106
 * (Lucratividade). Uma tool por endpoint, registradas a partir de descritores
 * para não repetir 21 vezes o mesmo tratamento de erro.
 *
 * Contrato: docs/api-winthor-mobile-rotinas-120-106.md
 */

// ---------------------------------------------------------------------------
// Peças de schema compartilhadas
// ---------------------------------------------------------------------------

/**
 * Lista de códigos. Aceita também um valor único (`"1"` ou `1`) e normaliza
 * para array — clientes MCP frequentemente enviam escalar quando há só um item.
 */
const listaCodigos = (descricao: string) =>
  z
    .union([
      z.array(z.coerce.string()),
      z.coerce.string().transform((valor) => [valor]),
    ])
    .optional()
    .describe(descricao);

/**
 * Enum de código que aceita número. Clientes MCP frequentemente enviam
 * `periodo: 3` em vez de `"3"`; o contrato do WinThor exige string.
 */
const enumCodigo = <T extends readonly [string, ...string[]]>(
  valores: T,
  descricao: string,
) => z.coerce.string().pipe(z.enum(valores)).optional().describe(descricao);

const paginacao = {
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Página (padrão: 1)'),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .optional()
    .describe(
      `${DESCRICAO_PAGE_SIZE} Padrão: ${PAGE_SIZE_DEFAULT}, máx: ${PAGE_SIZE_MAX}.`,
    ),
};

const filial = {
  listaFilial: listaCodigos(
    'Códigos de filial. Se omitido, usa todas as filiais visíveis ao usuário configurado.',
  ),
};

const periodo = {
  periodo: enumCodigo(
    ['1', '2', '3', '4', '7', '8'],
    '1=Hoje, 2=Ontem, 3=Mês atual (padrão), 4=Mês anterior, 7=Ano atual, 8=Ano anterior',
  ),
};

const filtrosInadimplencia = {
  ...filial,
  ...periodo,
  listaCliente: listaCodigos('Códigos de cliente. Omitido = todos.'),
  listaSupervisor: listaCodigos('Códigos de supervisor. Omitido = todos.'),
  listaTipoCobranca: listaCodigos(
    'Códigos de tipo de cobrança. Omitido = todos.',
  ),
  ...paginacao,
};

const filtrosLucratividade = {
  ...filial,
  ...periodo,
  listaCliente: listaCodigos('Códigos de cliente. Omitido = todos.'),
  listaEmitente: listaCodigos('Matrículas de emitente. Omitido = todos.'),
  listaRca: listaCodigos('Códigos de RCA. Omitido = todos.'),
  listaSupervisor: listaCodigos('Códigos de supervisor. Omitido = todos.'),
  margemMinLucro: z.coerce
    .string()
    .optional()
    .describe('Margem mínima de lucro em % (padrão: 100)'),
  numeroPedido: z.coerce.string().optional().describe('Número do pedido'),
  numeroPedidoRca: z.coerce
    .string()
    .optional()
    .describe('Número do pedido de RCA'),
  posicaoPedido: enumCodigo(
    ['0', '1', '2', '3', '4'],
    '0=Todos (padrão), 1=Bloqueado, 2=Pendente, 3=Liberado, 4=Faturado',
  ),
  ...paginacao,
};

const termoPesquisa = {
  termo: z.coerce
    .string()
    .optional()
    .describe('Código a pesquisar. Vazio ou omitido retorna todos, paginados.'),
  ...paginacao,
};

// ---------------------------------------------------------------------------
// Colunas por endpoint (§3.3, §4.4, §3.5, §4.6). `true` = totalizada.
// ---------------------------------------------------------------------------

/** Exportado para a sonda de paginação mandar colunas realistas. */
export const COLUNAS = {
  inadimplenciaPorFilial: [
    col('CODIGO'),
    col('DESCRICAO'),
    col('CVLPREVISTO', true),
    col('CVLRECEBDIA', true),
    col('CVLRECEBATRASO', true),
    col('CVLINADIMP', true),
    col('PARTICIPACAO'),
  ],
  inadimplenciaPorCliente: [
    col('CODIGO'),
    col('NOME'),
    col('MEDATRAZO'),
    col('QT', true),
    col('VALOR', true),
  ],
  inadimplenciaPorSupervisor: [
    col('CODIGO'),
    col('NOME'),
    col('VALOR_RECEBER', true),
    col('VALOR_RECEBIDO', true),
    col('VALOR_ATRASADO', true),
    col('VALOR', true),
    col('PARTICIPACAO'),
  ],
  inadimplenciaPorRamoAtividade: [
    col('CODIGO'),
    col('DESCRICAO'),
    col('QT_DUPLIC_ATRASO', true),
    col('VALOR', true),
  ],
  inadimplenciaPorCobranca: [
    col('CODIGO'),
    col('DESCRICAO'),
    col('QT', true),
    col('VALOR', true),
  ],
  inadimplenciaPorDiaAtraso: [
    col('EM_ABERTO'),
    col('QT_DUPLICATAS', true),
    col('VALOR', true),
  ],
  inadimplenciaPorValor: [
    col('VALORDUP'),
    col('QT_DUPLICATAS', true),
    col('VALOR', true),
  ],
  pedidosDeVenda: [
    col('NUMERO_PEDIDO'),
    col('CODIGO_FILIAL'),
    col('TIPO_VENDA'),
    col('DATA_PEDIDO'),
    col('POSICAO_PEDIDO'),
    col('CODIGO_CLIENTE'),
    col('NOME_CLIENTE'),
    col('VALOR_PEDIDO', true),
    col('PERCENTUAL_LUCRO'),
  ],
  lucratividadePorRca: [
    col('CODIGO'),
    col('NOME'),
    col('VALOR_TOTAL', true),
    col('VALOR_CUSTO_FINANCEIRO', true),
    col('PERC_CMV'),
    col('VALOR_LUCRO', true),
    col('PERC_LUCRO'),
  ],
  itensPedido: [
    col('CODPROD'),
    col('DESCRICAO'),
    col('EMBALAGEM'),
    col('QTDE', true),
    col('PRECO_VENDA', true),
    col('SUBTOTAL', true),
    col('CUSTO_FINANCEIRO', true),
    col('PERC_LUCRO'),
  ],
  faltasPedido: [
    col('CODPROD'),
    col('DESCRICAO'),
    col('EMBALAGEM'),
    col('QTDE', true),
    col('PRECO_VENDA', true),
    col('SUBTOTAL', true),
  ],
  codigoNome: [col('CODIGO'), col('NOME')],
  codigoNomeCnpj: [col('CODIGO'), col('NOME'), col('CNPJ')],
  codigoDescricao: [col('CODIGO'), col('DESCRICAO')],
  matriculaNome: [col('MATRICULA'), col('NOME')],
} as const;

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

// Os schemas zod já validam a forma dos argumentos; este alias amarra a passagem
// para o drill-down, que é o único com campos obrigatórios.
type DetalhePedidoArgs = Parameters<
  WinthorMobileService['listarDetalhePedido']
>[2];

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema?: z.ZodTypeAny;
  /** Filtros que reduzem esta consulta, citados quando a página é reduzida. */
  hint?: string;
  /** Classe de largura da linha; define o teto de pageSize. Omitido = padrão. */
  largura?: LarguraLinha;
  run: (
    args: ToolArgs,
    svc: WinthorMobileService,
  ) => Promise<WinthorApiResult<unknown>>;
}

/**
 * A capacidade de filtrar já existe; o que falta é o assistente saber disso na
 * hora em que a resposta é cortada. Reduzir colunas não adianta — o backend
 * ignora `data.list` no SELECT (§6.8) —, então filtro e página são as únicas
 * alavancas reais.
 */
const HINT_INADIMPLENCIA =
  'Filtros disponíveis: listaFilial, periodo, listaCliente, listaSupervisor, listaTipoCobranca.';
const HINT_LUCRATIVIDADE =
  'Filtros disponíveis: listaFilial, periodo, listaCliente, listaEmitente, listaRca, listaSupervisor, posicaoPedido, margemMinLucro.';
const HINT_PESQUISA = 'Informe `termo` para restringir a busca.';

/** Descritor de uma listagem da W120: só muda endpoint, colunas e o texto. */
function inadimplencia(
  name: string,
  title: string,
  description: string,
  endpoint: string,
  colunas: readonly ReturnType<typeof col>[],
): ToolDef {
  return {
    name,
    title,
    description,
    inputSchema: z.object(filtrosInadimplencia),
    hint: HINT_INADIMPLENCIA,
    // Medido na sonda: 91-244 chars/linha nas 7 perspectivas.
    largura: 'estreita',
    run: (args, svc) => svc.listarInadimplencia(endpoint, [...colunas], args),
  };
}

/** Descritor de um modal de pesquisa (§3.5, §4.6). */
function pesquisa(
  name: string,
  title: string,
  description: string,
  endpoint: string,
  chaveFiltro: string,
  colunas: readonly ReturnType<typeof col>[],
): ToolDef {
  return {
    name,
    title,
    description,
    inputSchema: z.object(termoPesquisa),
    hint: HINT_PESQUISA,
    // Medido na sonda: 49-107 chars/linha nos 7 lookups.
    largura: 'estreita',
    run: (args, svc) =>
      svc.pesquisar(
        endpoint,
        [...colunas],
        chaveFiltro,
        args.termo as string | undefined,
        args,
      ),
  };
}

const TOOLS: ToolDef[] = [
  // ---- Comuns às duas rotinas (§2) ----
  {
    name: 'wt_mobile_usuario_logado',
    title: 'Usuário logado (mobile)',
    description:
      'Retorna matrícula e nome do usuário da sessão WinThor usada pelas rotinas mobile.',
    run: (_args, svc) => svc.buscarUsuarioLogado(),
  },
  {
    name: 'wt_mobile_pesquisar_filial',
    title: 'Filiais do usuário',
    description:
      'Lista as filiais que uma matrícula pode acessar. Sem matrícula, usa a do usuário logado.',
    inputSchema: z.object({
      matricula: z.coerce
        .string()
        .optional()
        .describe('Matrícula do usuário. Omitido = usuário configurado.'),
      ...paginacao,
    }),
    run: async (args, svc) => {
      // O endpoint não pagina (envelope reduzido, §6.3); page/pageSize são
      // aplicados em processo e só quando explicitamente informados.
      const paginacaoArgs =
        args.page !== undefined || args.pageSize !== undefined
          ? { page: args.page as number, pageSize: args.pageSize as number }
          : undefined;
      const matricula = args.matricula as string | undefined;
      if (matricula) {
        return svc.pesquisarFilial(matricula, paginacaoArgs);
      }
      const usuario = await svc.buscarUsuarioLogado();
      if (!usuario.ok) return usuario;
      return svc.pesquisarFilial(
        toCodigo(usuario.data?.MATRICULA) ?? '',
        paginacaoArgs,
      );
    },
  },

  // ---- W120: Resumo de Inadimplência (§3.3) ----
  inadimplencia(
    'wt_inadimplencia_por_filial',
    'Inadimplência por filial',
    'Resumo de inadimplência agrupado por filial: previsto, recebido no dia, recebido em atraso, inadimplente e participação.',
    ENDPOINTS.inadimplenciaPorFilial,
    COLUNAS.inadimplenciaPorFilial,
  ),
  inadimplencia(
    'wt_inadimplencia_por_cliente',
    'Inadimplência por cliente',
    'Resumo de inadimplência por cliente, com média de atraso, quantidade de duplicatas e valor.',
    ENDPOINTS.inadimplenciaPorCliente,
    COLUNAS.inadimplenciaPorCliente,
  ),
  inadimplencia(
    'wt_inadimplencia_por_supervisor',
    'Inadimplência por supervisor',
    'Resumo de inadimplência por supervisor: a receber, recebido, atrasado, total e participação.',
    ENDPOINTS.inadimplenciaPorSupervisor,
    COLUNAS.inadimplenciaPorSupervisor,
  ),
  inadimplencia(
    'wt_inadimplencia_por_ramo_atividade',
    'Inadimplência por ramo de atividade',
    'Resumo de inadimplência por ramo de atividade do cliente, com duplicatas em atraso e valor.',
    ENDPOINTS.inadimplenciaPorRamoAtividade,
    COLUNAS.inadimplenciaPorRamoAtividade,
  ),
  inadimplencia(
    'wt_inadimplencia_por_cobranca',
    'Inadimplência por cobrança',
    'Resumo de inadimplência por tipo de cobrança, com quantidade e valor.',
    ENDPOINTS.inadimplenciaPorCobranca,
    COLUNAS.inadimplenciaPorCobranca,
  ),
  inadimplencia(
    'wt_inadimplencia_por_dia_atraso',
    'Inadimplência por dia de atraso',
    'Resumo de inadimplência por faixa de dias em aberto, com quantidade de duplicatas e valor.',
    ENDPOINTS.inadimplenciaPorDiaAtraso,
    COLUNAS.inadimplenciaPorDiaAtraso,
  ),
  inadimplencia(
    'wt_inadimplencia_por_valor',
    'Inadimplência por faixa de valor',
    'Resumo de inadimplência por faixa de valor da duplicata, com quantidade e valor.',
    ENDPOINTS.inadimplenciaPorValor,
    COLUNAS.inadimplenciaPorValor,
  ),
  {
    name: 'wt_inadimplencia_valor_carteira',
    title: 'Valor a receber da carteira',
    description:
      'Valor total a receber da carteira (posição atual — não depende de período).',
    inputSchema: z.object(filial),
    run: (args, svc) =>
      svc.consultarValorCarteira(args.listaFilial as string[] | undefined),
  },

  // ---- W120: lookups (§3.5) ----
  pesquisa(
    'wt_inadimplencia_pesquisar_supervisor',
    'Pesquisar supervisor (inadimplência)',
    'Lista supervisores para filtrar as consultas de inadimplência.',
    ENDPOINTS.inadimplenciaPesquisarSupervisor,
    'codigoSupervisor',
    COLUNAS.codigoNome,
  ),
  pesquisa(
    'wt_inadimplencia_pesquisar_cliente',
    'Pesquisar cliente (inadimplência)',
    'Lista clientes (código, nome, CNPJ) para filtrar as consultas de inadimplência.',
    ENDPOINTS.inadimplenciaPesquisarCliente,
    'codigoCliente',
    COLUNAS.codigoNomeCnpj,
  ),
  pesquisa(
    'wt_inadimplencia_pesquisar_tipo_cobranca',
    'Pesquisar tipo de cobrança',
    'Lista tipos de cobrança para filtrar as consultas de inadimplência.',
    ENDPOINTS.inadimplenciaPesquisarTipoCobranca,
    // A chave deste filtro é CODIGO em maiúsculas, fora do padrão camelCase (§3.5).
    'CODIGO',
    COLUNAS.codigoDescricao,
  ),

  // ---- W106: Lucratividade (§4.4) ----
  {
    name: 'wt_lucratividade_pedidos',
    title: 'Lucratividade por pedido',
    description:
      'Lista pedidos de venda com valor e percentual de lucro. Datas voltam em ISO 8601.',
    inputSchema: z.object(filtrosLucratividade),
    hint: HINT_LUCRATIVIDADE,
    // Medido na sonda: p95 727 chars/linha (o pedido completo, §6.8).
    largura: 'larga',
    run: (args, svc) =>
      svc.listarLucratividade(
        ENDPOINTS.pedidosDeVenda,
        [...COLUNAS.pedidosDeVenda],
        {
          ...args,
          perspectiva: '1',
        },
      ),
  },
  {
    name: 'wt_faturamento_agregado',
    title: 'Faturamento agregado',
    description:
      'Faturamento somado por uma dimensão: quantidade de pedidos, valor faturado, lucro, margem e participação, ordenado por valor. Use esta tool em vez de somar wt_lucratividade_pedidos na mão. `agruparPor: cliente` varre os pedidos e só cabe em recortes menores; `filial` e `supervisor` são exatos e não varrem nada; `rca` usa o agregado nativo do WinThor. Pedindo `cliente` num recorte grande demais, a resposta cai automaticamente para `filial` e sinaliza em `rebaixado`. O campo `conferencia` mostra que a soma por dimensão bate com o total do conjunto.',
    inputSchema: z.object({
      agruparPor: z
        .enum(['cliente', 'filial', 'supervisor', 'rca'])
        .optional()
        .describe(
          'Dimensão do agrupamento (padrão: cliente). cliente = varredura, só em recortes menores; filial/supervisor = exato e sem varredura; rca = agregado nativo.',
        ),
      permitirRebaixar: z
        .boolean()
        .optional()
        .describe(
          'Padrão true: quando `cliente` não cabe, agrupa por filial em vez de recusar.',
        ),
      // O WinThor não tem filtro de data — `periodo` é um enum fechado. Este
      // recorte só existe porque a base local guarda o dia de cada pedido.
      dataInicio: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          'Início do recorte (AAAA-MM-DD). Recorte por data livre é atendido apenas pela base local; sem ela, use `periodo`.',
        ),
      dataFim: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Fim do recorte (AAAA-MM-DD), inclusive.'),
      // Mesmos filtros da W106; `perspectiva` é escolhida pelo serviço.
      ...filtrosLucratividade,
    }),
    hint: HINT_LUCRATIVIDADE,
    // Linha agregada tem 8 campos curtos, ao contrário do pedido completo.
    largura: 'estreita',
    run: (args, svc) => svc.agregarFaturamento(args),
  },
  {
    name: 'wt_lucratividade_por_rca',
    title: 'Lucratividade por RCA',
    description:
      'Lucratividade sintética por RCA: valor total, custo financeiro, CMV e lucro.',
    inputSchema: z.object(filtrosLucratividade),
    hint: HINT_LUCRATIVIDADE,
    // Medido na sonda: 177 chars/linha.
    largura: 'estreita',
    run: (args, svc) =>
      svc.listarLucratividade(
        ENDPOINTS.lucratividadePorRca,
        [...COLUNAS.lucratividadePorRca],
        { ...args, perspectiva: '2' },
      ),
  },
  {
    name: 'wt_lucratividade_itens_pedido',
    title: 'Itens do pedido',
    description:
      'Itens de um pedido de venda com quantidade, preço, subtotal, custo e margem. Obtenha codigoPedido e nomeFilial em wt_lucratividade_pedidos.',
    inputSchema: z.object({
      codigoPedido: z.coerce.string().describe('NUMERO_PEDIDO do pedido'),
      nomeFilial: z.coerce.string().describe('NOME_FILIAL do pedido'),
      ...filial,
      ...paginacao,
    }),
    run: (args, svc) =>
      svc.listarDetalhePedido(
        ENDPOINTS.itensPedidoDeVenda,
        [...COLUNAS.itensPedido],
        args as unknown as DetalhePedidoArgs,
      ),
  },
  {
    name: 'wt_lucratividade_faltas_pedido',
    title: 'Faltas do pedido',
    description:
      'Itens em falta de um pedido de venda. Obtenha codigoPedido e nomeFilial em wt_lucratividade_pedidos.',
    inputSchema: z.object({
      codigoPedido: z.coerce.string().describe('NUMERO_PEDIDO do pedido'),
      nomeFilial: z.coerce.string().describe('NOME_FILIAL do pedido'),
      ...filial,
      ...paginacao,
    }),
    run: (args, svc) =>
      svc.listarDetalhePedido(
        ENDPOINTS.faltasPedidoDeVenda,
        [...COLUNAS.faltasPedido],
        args as unknown as DetalhePedidoArgs,
      ),
  },

  // ---- W106: lookups (§4.6) ----
  pesquisa(
    'wt_lucratividade_pesquisar_cliente',
    'Pesquisar cliente (lucratividade)',
    'Lista clientes (código, nome, CNPJ) para filtrar as consultas de lucratividade.',
    ENDPOINTS.lucratividadePesquisarCliente,
    'codigoCliente',
    COLUNAS.codigoNomeCnpj,
  ),
  pesquisa(
    'wt_lucratividade_pesquisar_emitente',
    'Pesquisar emitente',
    'Lista emitentes (matrícula, nome) para filtrar as consultas de lucratividade.',
    ENDPOINTS.lucratividadePesquisarEmitente,
    'matriculaEmitente',
    COLUNAS.matriculaNome,
  ),
  pesquisa(
    'wt_lucratividade_pesquisar_supervisor',
    'Pesquisar supervisor (lucratividade)',
    'Lista supervisores para filtrar as consultas de lucratividade.',
    ENDPOINTS.lucratividadePesquisarSupervisor,
    'codigoSupervisor',
    COLUNAS.codigoNome,
  ),
  pesquisa(
    'wt_lucratividade_pesquisar_rca',
    'Pesquisar RCA',
    'Lista RCAs para filtrar as consultas de lucratividade.',
    ENDPOINTS.lucratividadePesquisarRca,
    // Sigla em maiúsculas, fora do padrão dos demais lookups (§4.6).
    'codigoRCA',
    COLUNAS.codigoNome,
  ),
];

export function registerMobileTools(
  server: McpServer,
  mobile: WinthorMobileService,
): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      } as never,
      (async (args: ToolArgs = {}) =>
        toToolResult(await tool.run(args ?? {}, mobile), tool.hint)) as never,
    );
  }
}

/** Exposto para os testes conferirem a cobertura dos 21 endpoints. */
export const MOBILE_TOOL_NAMES = TOOLS.map((t) => t.name);

/** Classe de largura por tool, consumida pelo middleware de paginação. */
export const MOBILE_TOOL_LARGURAS: Record<string, LarguraLinha> =
  Object.fromEntries(TOOLS.map((t) => [t.name, t.largura ?? LARGURA_PADRAO]));
export type { PeriodoCodigo };
