import { Injectable } from '@nestjs/common';
import { clampPage, clampPageSize } from '../config/limits';
import { consultar } from '../vendas/duckdb';
import type { DuckDBValue } from '@duckdb/node-api';
import {
  medirCoberturaEstoque,
  motivoCoberturaIncompletaEstoque,
} from './estoque-cobertura';
import { EstoqueFatoDbService } from './estoque-fato-db.service';
import { EstoqueMetaDbService } from './estoque-meta-db.service';
import { EstoqueStoreService } from './estoque-store.service';

export interface ArgsBuscaEstoqueLocal {
  codigoFilial: string;
  produtoId?: string;
  descricao?: string;
  page?: number;
  pageSize?: number;
}

export type ResultadoBuscaEstoqueLocal =
  | { atendivel: false; motivo: string }
  | {
      atendivel: true;
      fonte: 'local';
      codigoFilial: string;
      page: number;
      pageSize: number;
      total: number;
      produtos: Record<string, unknown>[];
      atualizadoEm?: string;
    };

@Injectable()
export class EstoqueQueryService {
  constructor(
    private readonly metaDb: EstoqueMetaDbService,
    private readonly fatoDb: EstoqueFatoDbService,
    private readonly store: EstoqueStoreService,
  ) {}

  async buscar(args: ArgsBuscaEstoqueLocal): Promise<ResultadoBuscaEstoqueLocal> {
    const instanciaId = this.metaDb.instanciaId();
    if (instanciaId === null) {
      return { atendivel: false, motivo: 'servidor ainda não configurado' };
    }

    const db = this.metaDb.banco();
    const cobertura = medirCoberturaEstoque(db, instanciaId, [args.codigoFilial]);
    if (!cobertura.completa) {
      return {
        atendivel: false,
        motivo: motivoCoberturaIncompletaEstoque(cobertura),
      };
    }

    const page = clampPage(args.page);
    const pageSize = clampPageSize(args.pageSize);
    const offset = (page - 1) * pageSize;

    const fato = await this.fatoDb.conexao();
    const filtros = ['instancia_id = ?', 'codigo_filial = ?'];
    const params: DuckDBValue[] = [instanciaId, args.codigoFilial];

    if (args.produtoId) {
      filtros.push('codigo_produto = ?');
      params.push(String(args.produtoId));
    }
    if (args.descricao) {
      filtros.push('LOWER(descricao) LIKE ?');
      params.push(`%${args.descricao.toLowerCase()}%`);
    }

    const where = filtros.join(' AND ');
    const totalRow = await consultar<{ c: number }>(
      fato,
      `SELECT COUNT(*) AS c FROM produto_estoque WHERE ${where}`,
      params,
    );
    const total = Number(totalRow[0]?.c ?? 0);

    const linhas = await consultar<{
      codigo_produto: string;
      descricao: string | null;
      saldo: number | null;
      saldo_reservado: number | null;
    }>(
      fato,
      `SELECT codigo_produto, descricao, saldo, saldo_reservado
         FROM produto_estoque
        WHERE ${where}
        ORDER BY descricao NULLS LAST, codigo_produto
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    const coberturaRow = db
      .prepare(
        `SELECT atualizado_em FROM cobertura
          WHERE instancia_id = ? AND codigo_filial = ?`,
      )
      .get(instanciaId, args.codigoFilial) as
      | { atualizado_em: string }
      | undefined;

    const produtos = linhas.map((l) => ({
      produtoId: l.codigo_produto,
      codigoProduto: l.codigo_produto,
      descricao: l.descricao,
      saldo: l.saldo,
      saldoReservado: l.saldo_reservado,
    }));

    return {
      atendivel: true,
      fonte: 'local',
      codigoFilial: args.codigoFilial,
      page,
      pageSize,
      total,
      produtos,
      atualizadoEm: coberturaRow?.atualizado_em,
    };
  }

  resumoCobertura(instanciaId: number): {
    filiais: string[];
    fonte: 'sync' | 'cobertura';
    resumo: ReturnType<typeof medirCoberturaEstoque>;
  } {
    const db = this.metaDb.banco();
    const { filiais, fonte } = this.store.filiaisEsperadas(instanciaId);
    return {
      filiais,
      fonte,
      resumo: medirCoberturaEstoque(db, instanciaId, filiais),
    };
  }
}
