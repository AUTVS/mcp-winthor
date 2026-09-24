import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { EstoqueFatoDbService } from '../estoque/estoque-fato-db.service';
import { EstoqueIngestaoService } from '../estoque/estoque-ingestao.service';
import { EstoqueMetaDbService } from '../estoque/estoque-meta-db.service';
import { EstoqueQueryService } from '../estoque/estoque-query.service';
import { WtConfigService } from '../config/wt-config.service';
import { WinthorAuthService } from '../winthor/winthor-auth.service';
import { WinthorApiService } from '../winthor/winthor-api.service';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import { VendasFatoDbService } from '../vendas/vendas-fato-db.service';
import { VendasIngestaoService } from '../vendas/vendas-ingestao.service';
import { VendasMetaDbService } from '../vendas/vendas-meta-db.service';
import { VendasStoreService } from '../vendas/vendas-store.service';
import {
  clampPage,
  clampPageSize,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from '../config/limits';
import {
  ESTOQUE_TOOL_LARGURAS,
  registerEstoqueTools,
} from './tools/estoque-tools';
import {
  MOBILE_TOOL_LARGURAS,
  registerMobileTools,
} from './tools/mobile-tools';
import {
  DESCRICAO_PAGE_SIZE,
  instalarPaginacao,
  LarguraLinha,
} from './tools/pagination';
import { shapeToolResult, toToolResult } from './tools/tool-result';
import { registerVendasTools } from './tools/vendas-tools';

/**
 * Versão anunciada ao cliente MCP, lida do `package.json`.
 *
 * Era uma constante literal, e isso fazia dela uma **terceira** cópia da versão,
 * ao lado de `desktop/package.json` (que carimba o instalador) e
 * `server/package.json`. Com o incremento automático do build, a literal
 * envelheceria calada: o instalador sairia 0.2.0 e `wt_ping` continuaria
 * respondendo 0.1.0.
 *
 * `process.cwd()` é o diretório do servidor nos dois cenários — em dev o npm
 * roda a partir de `server/`, e no app empacotado o desktop passa
 * `cwd: serverDir` no spawn. Mesma premissa que `loadCatalogStats` já usa.
 */
function lerVersao(): string {
  try {
    const bruto = readFileSync(join(process.cwd(), 'package.json'), 'utf-8');
    const { version } = JSON.parse(bruto) as { version?: string };
    if (version) return version;
  } catch {
    // Cai no fallback abaixo.
  }
  // Nunca deixar a tool sem responder por causa disto: versão é informativa.
  return '0.0.0-desconhecida';
}

const SERVER_VERSION = lerVersao();

/** Largura de linha das tools registradas aqui (as mobile vêm do seu módulo). */
const LARGURA_FACTORY: Record<string, LarguraLinha> = {
  wt_list_filiais: 'larga',
  // Registro completo de cliente do ERP: endereço, documentos, flags.
  wt_buscar_clientes: 'enorme',
  wt_buscar_pedidos_venda: 'larga',
  wt_vendas_base_local: 'estreita',
};

@Injectable()
export class McpServerFactory {
  constructor(
    private readonly configService: WtConfigService,
    private readonly winthorAuth: WinthorAuthService,
    private readonly winthorApi: WinthorApiService,
    private readonly winthorMobile: WinthorMobileService,
    private readonly metaDb: VendasMetaDbService,
    private readonly fatoDb: VendasFatoDbService,
    private readonly vendasStore: VendasStoreService,
    private readonly vendasIngestao: VendasIngestaoService,
    private readonly estoqueMetaDb: EstoqueMetaDbService,
    private readonly estoqueFatoDb: EstoqueFatoDbService,
    private readonly estoqueIngestao: EstoqueIngestaoService,
    private readonly estoqueQuery: EstoqueQueryService,
  ) {}

  create(): McpServer {
    const server = new McpServer({
      name: 'wt.ai',
      version: SERVER_VERSION,
    });

    // Middleware: intercepta os 27 registros abaixo (inclusive os 21 do laço
    // de registerMobileTools) e garante o envelope de paginação.
    instalarPaginacao(server, {
      ...LARGURA_FACTORY,
      ...MOBILE_TOOL_LARGURAS,
      ...ESTOQUE_TOOL_LARGURAS,
    });

    server.registerTool(
      'wt_ping',
      {
        title: 'Ping wt.ai',
        description: 'Retorna versão do servidor MCP e status de configuração.',
      },
      () => {
        const configured = this.configService.isConfigured();
        const payload = {
          name: 'wt.ai',
          version: SERVER_VERSION,
          configured,
          message: configured
            ? 'Servidor configurado e pronto.'
            : 'Servidor ainda não configurado. Abra a página inicial para configurar.',
        };
        return shapeToolResult(payload);
      },
    );

    server.registerTool(
      'wt_test_connection',
      {
        title: 'Testar conexão WinThor',
        description: 'Testa login WTA com as credenciais configuradas.',
      },
      async () => {
        const result = await this.winthorAuth.testConnection();
        return shapeToolResult(result, !result.ok);
      },
    );

    server.registerTool(
      'wt_server_info',
      {
        title: 'Info do servidor',
        description:
          'Retorna URL base WinThor, login e contagem de bundles/endpoints do catálogo.',
      },
      () => {
        const cfg = this.configService.getConfig();
        const catalog = this.loadCatalogStats();
        const payload = {
          version: SERVER_VERSION,
          configured: !!cfg,
          winthorBaseUrl: cfg?.winthorBaseUrl ?? null,
          login: cfg?.login ?? null,
          configuredAt: cfg?.configuredAt ?? null,
          catalog,
        };
        return shapeToolResult(payload);
      },
    );

    server.registerTool(
      'wt_list_filiais',
      {
        title: 'Listar filiais',
        description:
          'Retorna as filiais do WinThor (GET /filial/listar/todas). O endpoint não pagina, então a paginação é aplicada localmente.',
        inputSchema: z.object({
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
          refresh: z
            .boolean()
            .optional()
            .describe('Ignora o cache e rebusca a lista no WinThor.'),
        }),
      },
      async ({ page, pageSize, refresh }) => {
        const result = await this.winthorApi.listarTodasFiliais({ refresh });
        if (!result.ok) {
          return toToolResult(result);
        }

        const todas = Array.isArray(result.data) ? result.data : [];
        const safePage = clampPage(page);
        const safePageSize = clampPageSize(pageSize);
        const inicio = (safePage - 1) * safePageSize;
        const filiais = todas.slice(inicio, inicio + safePageSize);

        return shapeToolResult({
          ok: true,
          count: filiais.length,
          page: safePage,
          pageSize: safePageSize,
          total: todas.length,
          totalPages:
            todas.length === 0 ? 0 : Math.ceil(todas.length / safePageSize),
          cachedAt: result.cachedAt,
          filiais,
        });
      },
    );

    server.registerTool(
      'wt_buscar_clientes',
      {
        title: 'Buscar clientes',
        description:
          'Consulta clientes no WinThor por código e/ou nome. Suporta paginação local (page/pageSize).',
        inputSchema: z.object({
          codigo: z.coerce.string().optional().describe('Código do cliente'),
          nome: z
            .string()
            .optional()
            .describe('Nome ou parte do nome do cliente'),
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
          refresh: z
            .boolean()
            .optional()
            .describe('Ignora o cache e rebusca a lista no WinThor.'),
        }),
      },
      async ({ codigo, nome, page, pageSize, refresh }) => {
        const result = await this.winthorApi.buscarClientes({
          codigo,
          nome,
          page,
          pageSize,
          refresh,
        });
        if (!result.ok) {
          return toToolResult(result);
        }

        const paginated = result.data;
        const clientes = paginated?.items;
        return shapeToolResult({
          ok: true,
          count: clientes?.length,
          page: paginated?.page,
          pageSize: paginated?.pageSize,
          total: paginated?.total,
          totalPages: paginated?.totalPages,
          cachedAt: paginated?.cachedAt,
          // O endpoint só aceita `codigo` e `nome`; sem eles a base inteira é
          // varrida antes de fatiar. Avisar é mais barato que exigir.
          ...(codigo || nome
            ? {}
            : {
                hint: 'Consulta sem filtro varre a base inteira; informe codigo ou nome.',
              }),
          clientes,
        });
      },
    );

    server.registerTool(
      'wt_buscar_pedidos_venda',
      {
        title: 'Buscar pedidos',
        description:
          'Busca pedidos com filtros (GET /logistica/apis/v1/pedido/buscar). Paginação nativa (page/pageSize).',
        inputSchema: z.object({
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
          dataUltimaAlteracao: z
            .string()
            .optional()
            .describe(
              'Data mínima da última alteração (ISO ou formato aceito pela API)',
            ),
          status: z
            .string()
            .optional()
            .describe('Status do pedido (padrão: ATIVO)'),
        }),
      },
      async (args) => {
        const result = await this.winthorApi.buscarPedidos(args);
        if (!result.ok) {
          return toToolResult(result);
        }

        const items =
          result.data &&
          typeof result.data === 'object' &&
          'items' in result.data &&
          Array.isArray((result.data as { items: unknown[] }).items)
            ? (result.data as { items: unknown[] }).items
            : Array.isArray(result.data)
              ? result.data
              : undefined;

        return shapeToolResult({
          ok: true,
          page: clampPage(args.page),
          pageSize: clampPageSize(args.pageSize),
          status: args.status ?? 'ATIVO',
          first:
            result.data &&
            typeof result.data === 'object' &&
            'first' in result.data
              ? (result.data as { first: boolean }).first
              : undefined,
          hasNext:
            result.data &&
            typeof result.data === 'object' &&
            'hasNext' in result.data
              ? (result.data as { hasNext: boolean }).hasNext
              : undefined,
          count: items?.length,
          pedidos: items ?? result.data,
        });
      },
    );

    registerEstoqueTools(
      server,
      this.winthorApi,
      this.estoqueMetaDb,
      this.estoqueFatoDb,
      this.estoqueIngestao,
      this.estoqueQuery,
    );

    // Rotinas mobile W120 (inadimplência) e W106 (lucratividade) — 21 tools.
    registerMobileTools(server, this.winthorMobile);

    // Base local de vendas: status da cobertura e disparo da sincronização.
    registerVendasTools(
      server,
      this.metaDb,
      this.fatoDb,
      this.vendasStore,
      this.vendasIngestao,
    );

    return server;
  }

  private catalogStats?: CatalogStats;

  /**
   * O catálogo é um arquivo de 223 KB relido e reparseado de forma síncrona a
   * cada chamada. A factory é singleton (só `create()` roda por requisição),
   * então memoizar aqui vale para todo o processo.
   */
  private loadCatalogStats(): CatalogStats {
    if (this.catalogStats) return this.catalogStats;

    const candidates = [
      join(process.cwd(), '..', 'docs', 'api', 'endpoints.json'),
      join(process.cwd(), 'docs', 'api', 'endpoints.json'),
    ];
    const source = candidates.find((p) => existsSync(p)) ?? null;
    if (!source) {
      return (this.catalogStats = { bundles: 0, endpoints: 0, source: null });
    }
    try {
      const data = JSON.parse(readFileSync(source, 'utf-8')) as Record<
        string,
        { classes?: Array<{ endpoints?: unknown[] }> }
      >;
      const bundles = Object.keys(data).length;
      let endpoints = 0;
      for (const bundle of Object.values(data)) {
        for (const cls of bundle.classes ?? []) {
          endpoints += cls.endpoints?.length ?? 0;
        }
      }
      return (this.catalogStats = { bundles, endpoints, source });
    } catch {
      return (this.catalogStats = { bundles: 0, endpoints: 0, source });
    }
  }
}

interface CatalogStats {
  bundles: number;
  endpoints: number;
  source: string | null;
}
