import { McpServer } from '@modelcontextprotocol/server';
import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  coberturaPorMes,
  medirCobertura,
  type ResumoCobertura,
} from '../../vendas/cobertura';
import {
  janelaFria,
  janelaHistorico,
  janelaQuente,
  type Janela,
} from '../../vendas/periodo-janela';
import { contarDimensoes } from '../../vendas/vendas-dimensao';
import { VendasFatoDbService } from '../../vendas/vendas-fato-db.service';
import { VendasIngestaoService } from '../../vendas/vendas-ingestao.service';
import { VendasMetaDbService } from '../../vendas/vendas-meta-db.service';
import { VendasStoreService } from '../../vendas/vendas-store.service';
import { shapeToolResult } from './tool-result';

/**
 * As mesmas duas zonas do painel, pelo mesmo motivo: `'3'` ⊂ `'7'` e `'4'` ⊂ `'7'`,
 * então relatar os quatro períodos do enum contava os mesmos dias duas vezes.
 */
const ZONAS: {
  escopo: 'atualizacao' | 'historico';
  rotulo: string;
  janela: (agora: Date) => Janela;
}[] = [
  {
    escopo: 'atualizacao',
    rotulo: 'mês atual e anterior',
    janela: janelaQuente,
  },
  { escopo: 'historico', rotulo: 'até o mês retrasado', janela: janelaFria },
];

function tamanhoMb(caminho: string): number | undefined {
  try {
    return Math.round((statSync(caminho).size / 1e6) * 10) / 10;
  } catch {
    return undefined;
  }
}

/**
 * Frase acionável a partir do estado das zonas.
 *
 * Antes o hint só sabia dizer "Base vazia", e só quando a cobertura estava
 * literalmente zerada — cobertura parcial passava calada.
 */
function hintDeCobertura(
  zonas: { escopo: string; rotulo: string; resumo: ResumoCobertura }[],
): string | undefined {
  const incompletas = zonas.filter((z) => !z.resumo.completa);
  if (!incompletas.length) return undefined;

  if (incompletas.every((z) => z.resumo.paresCobertos === 0)) {
    return 'Base vazia. Use wt_vendas_sincronizar com escopo "historico" para carregar ano atual e anterior, ou "atualizacao" para só mês atual e anterior.';
  }

  return incompletas
    .map(
      (z) =>
        `zona "${z.escopo}" (${z.rotulo}) incompleta: ${z.resumo.paresCobertos} de ` +
        `${z.resumo.paresEsperados} pares (dia × filial), ${z.resumo.faltantes.length} dia(s) ` +
        `sem cobertura completa — rode wt_vendas_sincronizar com escopo "${z.escopo}".`,
    )
    .join(' ');
}

export function registerVendasTools(
  server: McpServer,
  metaDb: VendasMetaDbService,
  fatoDb: VendasFatoDbService,
  store: VendasStoreService,
  ingestao: VendasIngestaoService,
): void {
  server.registerTool(
    'wt_vendas_base_local',
    {
      title: 'Base local de vendas',
      description:
        'Mostra o que a base local de vendas já cobre (por mês e filial), a defasagem, o andamento da sincronização e os lotes que não fecharam com o ERP. A base é o que faz wt_faturamento_agregado responder por cliente em milissegundos, sem o teto de pedidos varridos.',
      inputSchema: z.object({
        detalharMeses: z
          .boolean()
          .optional()
          .describe('Inclui a cobertura mês a mês (padrão: true).'),
      }),
    },
    async (args: { detalharMeses?: boolean } = {}) => {
      const instanciaId = metaDb.instanciaId();
      if (instanciaId === null) {
        return shapeToolResult({
          ok: false,
          configurado: false,
          hint: 'Servidor ainda não configurado. Abra a página inicial para configurar.',
        });
      }

      const db = metaDb.banco();
      const agora = new Date();
      const { filiais, fonte } = store.filiaisEsperadas(instanciaId);
      const horizonte = janelaHistorico(agora);

      // Mesmo predicado que o painel e que VendasQueryService usam. Antes esta tool
      // tinha a própria variante de SQL, contando `DISTINCT dia` sem filial — e por
      // isso podia relatar cobertura que a consulta recusaria.
      const zonas = ZONAS.map((z) => {
        const janela = z.janela(agora);
        const resumo = medirCobertura(db, { instanciaId, janela, filiais });
        return { ...z, janela, resumo };
      });

      const resumo = db
        .prepare(
          `SELECT COUNT(*) AS pares,
                  MIN(dia) AS primeiro_dia, MAX(dia) AS ultimo_dia,
                  MIN(atualizado_em) AS mais_antigo
             FROM cobertura WHERE instancia_id = ?`,
        )
        .get(instanciaId) as {
        pares: number;
        primeiro_dia: string | null;
        ultimo_dia: string | null;
        mais_antigo: string | null;
      };

      const pedidos = await fatoDb.contarPedidos(instanciaId);

      const problemas = db
        .prepare(
          `SELECT codigo_filial, periodo, estado, motivo, divergencia_pct
             FROM lote
            WHERE instancia_id = ? AND estado <> 'completo'
            ORDER BY id DESC LIMIT 10`,
        )
        .all(instanciaId) as Record<string, unknown>[];

      const ancora = db
        .prepare(
          `SELECT codigo_filial, periodo, divergencia_pct, verificado_em
             FROM ancora
            WHERE instancia_id = ? AND confere = 0
            ORDER BY verificado_em DESC LIMIT 10`,
        )
        .all(instanciaId) as Record<string, unknown>[];

      const meses =
        args.detalharMeses === false
          ? undefined
          : coberturaPorMes(db, { instanciaId, janela: horizonte, filiais });

      const status = ingestao.status();
      const dims = contarDimensoes(db, instanciaId);

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
          linhas: pedidos,
          integridade: await fatoDb.integridade(),
        },
        dims,
        pedidos,
        filiais: {
          esperadas: filiais,
          // 'sync' = registrado pela última varredura padrão; 'cobertura' = inferido
          // do que já foi gravado, que é otimista enquanto nenhuma varredura rodou.
          fonte,
        },
        cobertura: {
          primeiroDia: resumo.primeiro_dia,
          ultimoDia: resumo.ultimo_dia,
          atualizadoEm: resumo.mais_antigo,
        },
        zonas: zonas.map((z) => ({
          escopo: z.escopo,
          rotulo: z.rotulo,
          dataInicio: z.janela.dataInicio,
          dataFim: z.janela.dataFim,
          completa: z.resumo.completa,
          dias: z.resumo.dias,
          diasCobertos: z.resumo.diasCompletos,
          paresEsperados: z.resumo.paresEsperados,
          paresCobertos: z.resumo.paresCobertos,
          diasFaltantes: z.resumo.faltantes.length,
          atualizadoEm: z.resumo.atualizadoEm,
          suspeitos: z.resumo.suspeitos,
        })),
        sincronizacao: status,
        lotesComProblema: problemas,
        ancora,
        ...(meses ? { meses } : {}),
        ...(() => {
          const hint = hintDeCobertura(zonas);
          return hint ? { hint } : {};
        })(),
      });
    },
  );

  server.registerTool(
    'wt_vendas_sincronizar',
    {
      title: 'Sincronizar base local',
      description:
        'Dispara a carga da base local de vendas e volta na hora — o trabalho segue em segundo plano, acompanhado por wt_vendas_base_local. `historico` varre ano atual e anterior (demorado: ordem de horas em muitas filiais); `atualizacao` varre mês atual e anterior, que é a janela que o WinThor ainda reconstrói de forma exata.',
      inputSchema: z.object({
        escopo: z
          .enum(['historico', 'atualizacao'])
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
        escopo?: 'historico' | 'atualizacao';
        filiais?: string[];
        cancelar?: boolean;
      } = {},
    ) => {
      if (args.cancelar) {
        ingestao.cancelar();
        return shapeToolResult({
          ok: true,
          cancelado: true,
          hint: 'A sincronização para na próxima página. O que já foi gravado e conferido continua valendo.',
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
            ? 'Sincronização iniciada em segundo plano. Acompanhe com wt_vendas_base_local; as tools continuam respondendo normalmente durante a varredura.'
            : undefined,
        },
        !r.aceito,
      );
    },
  );
}

export const VENDAS_TOOL_NAMES = [
  'wt_vendas_base_local',
  'wt_vendas_sincronizar',
];
