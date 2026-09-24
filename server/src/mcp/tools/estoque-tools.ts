import { McpServer } from '@modelcontextprotocol/server';
import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  clampPage,
  clampPageSize,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from '../../config/limits';
import { EstoqueFatoDbService } from '../../estoque/estoque-fato-db.service';
import { EstoqueIngestaoService } from '../../estoque/estoque-ingestao.service';
import { EstoqueMetaDbService } from '../../estoque/estoque-meta-db.service';
import { contarDimensoesEstoque } from '../../estoque/estoque-dimensao';
import { EstoqueQueryService } from '../../estoque/estoque-query.service';
import { WinthorApiService } from '../../winthor/winthor-api.service';
import { extrairItensEstoque } from '../../estoque/estoque-resposta';
import {
  DESCRICAO_PAGE_SIZE,
  LarguraLinha,
} from './pagination';
import { shapeToolResult, toToolResult } from './tool-result';

export const ESTOQUE_TOOL_LARGURAS: Record<string, LarguraLinha> = {
  wt_estoque_por_filial: 'media',
  wt_estoque_base_local: 'estreita',
};

function tamanhoMb(caminho: string): number | undefined {
  try {
    return Math.round((statSync(caminho).size / 1e6) * 10) / 10;
  } catch {
    return undefined;
  }
}

function hintDeCoberturaEstoque(
  resumo: { completa: boolean; filiaisCobertas: number; filiaisEsperadas: number },
): string | undefined {
  if (resumo.completa) return undefined;
  if (resumo.filiaisCobertas === 0) {
    return 'Base de estoque vazia. Use wt_estoque_sincronizar com escopo "completo" para carregar todas as filiais visíveis.';
  }
  return 'Cobertura incompleta — rode wt_estoque_sincronizar com escopo "atualizacao" ou "completo".';
}

export function registerEstoqueTools(
  server: McpServer,
  winthorApi: WinthorApiService,
  metaDb: EstoqueMetaDbService,
  fatoDb: EstoqueFatoDbService,
  ingestao: EstoqueIngestaoService,
  query: EstoqueQueryService,
): void {
  server.registerTool(
    'wt_estoque_base_local',
    {
      title: 'Base local de estoque',
      description:
        'Mostra cobertura por filial, contagem de produtos, andamento da sincronização e lotes com problema. A base local permite consultas rápidas via wt_estoque_por_filial sem varrer o ERP em cada chamada.',
      inputSchema: z.object({}),
    },
    async () => {
      const instanciaId = metaDb.instanciaId();
      if (instanciaId === null) {
        return shapeToolResult({
          ok: false,
          configurado: false,
          hint: 'Servidor ainda não configurado. Abra a página inicial para configurar.',
        });
      }

      const db = metaDb.banco();
      const { filiais, fonte, resumo } = query.resumoCobertura(instanciaId);
      const produtos = await fatoDb.contarProdutos(instanciaId);
      const status = ingestao.status();

      const problemas = db
        .prepare(
          `SELECT codigo_filial, estado, motivo, qt_local, total_upstream
             FROM lote
            WHERE instancia_id = ? AND estado <> 'completo'
            ORDER BY id DESC LIMIT 10`,
        )
        .all(instanciaId) as Record<string, unknown>[];

      const cobertura = db
        .prepare(
          `SELECT codigo_filial, qt_produtos, atualizado_em, estado
             FROM cobertura WHERE instancia_id = ?
             ORDER BY codigo_filial`,
        )
        .all(instanciaId) as Record<string, unknown>[];

      const dims = contarDimensoesEstoque(db, instanciaId);
      const hint = hintDeCoberturaEstoque(resumo);

      return shapeToolResult({
        ok: true,
        configurado: true,
        meta: {
          caminho: metaDb.caminhoArquivo(),
          versao: metaDb.versaoEsquema(),
          tamanhoMb: tamanhoMb(metaDb.caminhoArquivo()),
          integridade: metaDb.integridade(),
        },
        fato: {
          caminho: fatoDb.caminhoArquivo(),
          versao: await fatoDb.versaoEsquema(),
          tamanhoMb: tamanhoMb(fatoDb.caminhoArquivo()),
          linhas: produtos,
          integridade: await fatoDb.integridade(),
        },
        dims,
        produtos,
        filiais: { esperadas: filiais, fonte },
        cobertura: {
          completa: resumo.completa,
          filiaisEsperadas: resumo.filiaisEsperadas,
          filiaisCobertas: resumo.filiaisCobertas,
          faltantes: resumo.faltantes,
          atualizadoEm: resumo.atualizadoEm,
          porFilial: cobertura,
        },
        sincronizacao: status,
        lotesComProblema: problemas,
        ...(hint ? { hint } : {}),
      });
    },
  );

  server.registerTool(
    'wt_estoque_sincronizar',
    {
      title: 'Sincronizar base local de estoque',
      description:
        'Dispara a carga da base local de estoque por filial e volta na hora — o trabalho segue em segundo plano. `completo` varre todas as filiais visíveis; `atualizacao` refresca filiais com cobertura vencida.',
      inputSchema: z.object({
        escopo: z
          .enum(['completo', 'atualizacao'])
          .optional()
          .describe('Padrão: atualizacao.'),
        filiais: z
          .union([
            z.array(z.coerce.string()),
            z.coerce.string().transform((v) => [v]),
          ])
          .optional()
          .describe(
            'Códigos de filial. Omitido = todas as filiais visíveis ao usuário configurado.',
          ),
        cancelar: z
          .boolean()
          .optional()
          .describe('Interrompe a sincronização em curso.'),
      }),
    },
    (
      args: {
        escopo?: 'completo' | 'atualizacao';
        filiais?: string[];
        cancelar?: boolean;
      } = {},
    ) => {
      if (args.cancelar) {
        ingestao.cancelar();
        return shapeToolResult({
          ok: true,
          cancelado: true,
          hint: 'A sincronização para na próxima página. O que já foi gravado continua valendo.',
        });
      }

      const escopo = args.escopo ?? 'atualizacao';
      const r = ingestao.sincronizar({ escopo, filiais: args.filiais });

      return shapeToolResult(
        {
          ok: r.aceito,
          escopo,
          ...(r.motivo ? { motivo: r.motivo } : {}),
          status: ingestao.status(),
          hint: r.aceito
            ? 'Sincronização de estoque iniciada em segundo plano. Acompanhe com wt_estoque_base_local.'
            : undefined,
        },
        !r.aceito,
      );
    },
  );

  server.registerTool(
    'wt_estoque_por_filial',
    {
      title: 'Estoque por filial',
      description:
        'Consulta estoque/saldo de produtos numa filial. Usa a base local quando a filial tem cobertura; senão consulta o WinThor ao vivo (GET /wms/api/v1/produto/buscar-produtos). Requer codigoFilial.',
      inputSchema: z.object({
        codigoFilial: z.coerce
          .string()
          .min(1)
          .describe('Código da filial (obrigatório)'),
        produtoId: z.coerce
          .string()
          .optional()
          .describe('Código do produto'),
        descricao: z
          .string()
          .optional()
          .describe('Descrição ou parte da descrição do produto'),
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
        forcarLive: z
          .boolean()
          .optional()
          .describe(
            'Ignora a base local e consulta o WinThor ao vivo mesmo com cobertura.',
          ),
      }),
    },
    async (args) => {
      if (!args.forcarLive) {
        const local = await query.buscar(args);
        if (local.atendivel) {
          return shapeToolResult({
            ok: true,
            fonte: 'local',
            codigoFilial: local.codigoFilial,
            page: local.page,
            pageSize: local.pageSize,
            total: local.total,
            count: local.produtos.length,
            atualizadoEm: local.atualizadoEm,
            produtos: local.produtos,
          });
        }
      }

      const result = await winthorApi.buscarEstoquePorFilial(args);
      if (!result.ok) {
        return toToolResult(result);
      }

      const itens = extrairItensEstoque(result.data);

      return shapeToolResult({
        ok: true,
        fonte: 'live',
        codigoFilial: args.codigoFilial,
        page: clampPage(args.page),
        pageSize: clampPageSize(args.pageSize),
        count: itens.length,
        produtos: itens.length ? itens : result.data,
        hint: args.forcarLive
          ? undefined
          : 'Consulta ao vivo. Rode wt_estoque_sincronizar para gravar localmente.',
      });
    },
  );
}
