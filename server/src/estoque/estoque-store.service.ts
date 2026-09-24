import { Injectable, Logger } from '@nestjs/common';
import { executarParams, consultar } from '../vendas/duckdb';
import {
  codigoProduto,
  descricaoProduto,
  saldoProduto,
  saldoReservadoProduto,
} from './estoque-resposta';
import { upsertDimensaoEstoque } from './estoque-dimensao';
import { EstoqueFatoDbService } from './estoque-fato-db.service';
import { EstoqueMetaDbService } from './estoque-meta-db.service';

export type EstadoLoteEstoque =
  | 'em_andamento'
  | 'completo'
  | 'parcial'
  | 'falhou';

export interface FechamentoLoteEstoque {
  estado: Exclude<EstadoLoteEstoque, 'em_andamento'>;
  paginas: number;
  totalUpstream?: number;
  motivo?: string;
  agora?: Date;
}

export interface ResultadoFechamentoEstoque {
  estado: EstadoLoteEstoque;
  linhas: number;
  removidos: number;
}

interface LinhaLoteEstoque {
  id: number;
  instancia_id: number;
  codigo_filial: string;
  linhas: number;
}

@Injectable()
export class EstoqueStoreService {
  private readonly logger = new Logger(EstoqueStoreService.name);

  constructor(
    private readonly metaDb: EstoqueMetaDbService,
    private readonly fatoDb: EstoqueFatoDbService,
  ) {}

  abrirLote(instanciaId: number, codigoFilial: string): number {
    const db = this.metaDb.banco();
    db.prepare(
      `INSERT INTO lote (instancia_id, codigo_filial, iniciado_em, estado)
       VALUES (?, ?, ?, 'em_andamento')`,
    ).run(instanciaId, codigoFilial, new Date().toISOString());

    const linha = db.prepare('SELECT last_insert_rowid() AS id').get() as {
      id: number;
    };
    return linha.id;
  }

  async gravarPagina(
    loteId: number,
    produtos: Record<string, unknown>[],
    proximaPagina: number,
  ): Promise<{ gravados: number; semCodigo: number }> {
    const meta = this.metaDb.banco();
    const lote = this.lerLote(loteId);
    if (!lote) throw new Error(`lote ${loteId} não existe`);

    const agora = new Date().toISOString();
    let gravados = 0;
    let semCodigo = 0;
    const fatos: unknown[][] = [];

    meta.exec('BEGIN');
    try {
      const dimFilialId = upsertDimensaoEstoque(
        meta,
        'dim_filial',
        lote.instancia_id,
        lote.codigo_filial,
        null,
        agora,
      );

      for (const item of produtos) {
        const codigo = codigoProduto(item);
        if (!codigo) {
          semCodigo++;
          continue;
        }

        const descricao = descricaoProduto(item);
        const dimProdutoId = upsertDimensaoEstoque(
          meta,
          'dim_produto',
          lote.instancia_id,
          codigo,
          descricao,
          agora,
        );

        fatos.push([
          lote.instancia_id,
          lote.codigo_filial,
          codigo,
          descricao,
          saldoProduto(item),
          saldoReservadoProduto(item),
          dimFilialId,
          dimProdutoId,
          loteId,
          agora,
        ]);
        gravados++;
      }

      meta
        .prepare(
          `UPDATE lote SET paginas = paginas + 1, linhas = linhas + ?,
                         proxima_pagina = ?
           WHERE id = ?`,
        )
        .run(gravados, proximaPagina, loteId);
      meta.exec('COMMIT');
    } catch (err) {
      meta.exec('ROLLBACK');
      throw err;
    }

    if (fatos.length) {
      const fato = await this.fatoDb.conexao();
      const sql = `INSERT OR REPLACE INTO produto_estoque (
        instancia_id, codigo_filial, codigo_produto, descricao, saldo,
        saldo_reservado, dim_filial_id, dim_produto_id, lote_id, ingerido_em
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`;

      for (const params of fatos) {
        await executarParams(fato, sql, params as never[]);
      }
    }

    return { gravados, semCodigo };
  }

  async fecharLote(
    loteId: number,
    f: FechamentoLoteEstoque,
  ): Promise<ResultadoFechamentoEstoque> {
    const meta = this.metaDb.banco();
    const lote = this.lerLote(loteId);
    if (!lote) throw new Error(`lote ${loteId} não existe`);

    const concluidoEm = (f.agora ?? new Date()).toISOString();

    if (f.estado !== 'completo') {
      meta
        .prepare(
          `UPDATE lote SET estado = ?, concluido_em = ?, paginas = ?, motivo = ?
           WHERE id = ?`,
        )
        .run(f.estado, concluidoEm, f.paginas, f.motivo ?? null, loteId);
      this.logger.warn(
        `lote estoque ${loteId} (filial ${lote.codigo_filial}) ` +
          `terminou como ${f.estado}: ${f.motivo ?? 'sem motivo'}.`,
      );
      return { estado: f.estado, linhas: lote.linhas, removidos: 0 };
    }

    const fato = await this.fatoDb.conexao();
    await executarParams(
      fato,
      `DELETE FROM produto_estoque
        WHERE instancia_id = ? AND codigo_filial = ? AND lote_id <> ?`,
      [lote.instancia_id, lote.codigo_filial, loteId],
    );

    const localRows = await consultar<{ qt: number }>(
      fato,
      `SELECT COUNT(*) AS qt FROM produto_estoque
        WHERE instancia_id = ? AND codigo_filial = ?`,
      [lote.instancia_id, lote.codigo_filial],
    );
    const qtLocal = Number(localRows[0]?.qt ?? 0);

    const confereTotal =
      f.totalUpstream === undefined || qtLocal === f.totalUpstream;

    meta.exec('BEGIN');
    try {
      meta
        .prepare(
          `UPDATE lote SET estado = ?, concluido_em = ?, paginas = ?, motivo = ?,
                         total_upstream = ?, qt_local = ?
           WHERE id = ?`,
        )
        .run(
          confereTotal ? 'completo' : 'parcial',
          concluidoEm,
          f.paginas,
          f.motivo ?? null,
          f.totalUpstream ?? null,
          qtLocal,
          loteId,
        );

      if (confereTotal) {
        meta
          .prepare(
            `INSERT INTO cobertura (instancia_id, codigo_filial, lote_id,
                                    atualizado_em, qt_produtos, estado)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(instancia_id, codigo_filial) DO UPDATE SET
               lote_id = excluded.lote_id,
               atualizado_em = excluded.atualizado_em,
               qt_produtos = excluded.qt_produtos,
               estado = excluded.estado`,
          )
          .run(
            lote.instancia_id,
            lote.codigo_filial,
            loteId,
            concluidoEm,
            qtLocal,
            'ok',
          );
      }

      meta.exec('COMMIT');
      return {
        estado: confereTotal ? 'completo' : 'parcial',
        linhas: qtLocal,
        removidos: 0,
      };
    } catch (err) {
      meta.exec('ROLLBACK');
      throw err;
    }
  }

  expirarLotesOrfaos(agora = new Date()): number {
    const db = this.metaDb.banco();
    const orfaos = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM lote WHERE estado = 'em_andamento'`)
        .get() as { n: number }
    ).n;

    if (orfaos === 0) return 0;

    db.prepare(
      `UPDATE lote
          SET estado = 'falhou',
              concluido_em = ?,
              motivo = COALESCE(motivo || ' | ', '') ||
                       'interrompido: processo encerrado durante a varredura'
        WHERE estado = 'em_andamento'`,
    ).run(agora.toISOString());

    this.logger.warn(
      `${orfaos} lote(s) de estoque ficaram em_andamento; marcados como falhou.`,
    );
    return orfaos;
  }

  registrarFiliaisAlvo(
    instanciaId: number,
    filiais: string[],
    agora = new Date(),
  ): void {
    const db = this.metaDb.banco();
    const carimbo = agora.toISOString();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM filial_alvo WHERE instancia_id = ?').run(
        instanciaId,
      );
      const gravar = db.prepare(
        `INSERT INTO filial_alvo (instancia_id, codigo_filial, registrado_em)
         VALUES (?,?,?)`,
      );
      for (const codigo of new Set(filiais.map(String))) {
        gravar.run(instanciaId, codigo, carimbo);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  filiaisEsperadas(instanciaId: number): {
    filiais: string[];
    fonte: 'sync' | 'cobertura';
  } {
    const db = this.metaDb.banco();
    const alvo = db
      .prepare(
        `SELECT codigo_filial FROM filial_alvo
          WHERE instancia_id = ? ORDER BY codigo_filial`,
      )
      .all(instanciaId) as { codigo_filial: string }[];

    if (alvo.length) {
      return { filiais: alvo.map((f) => f.codigo_filial), fonte: 'sync' };
    }

    const cobertura = db
      .prepare(
        `SELECT codigo_filial FROM cobertura
          WHERE instancia_id = ? ORDER BY codigo_filial`,
      )
      .all(instanciaId) as { codigo_filial: string }[];

    return {
      filiais: cobertura.map((f) => f.codigo_filial),
      fonte: 'cobertura',
    };
  }

  temCobertura(instanciaId: number): boolean {
    const db = this.metaDb.banco();
    const linha = db
      .prepare(`SELECT COUNT(*) AS c FROM cobertura WHERE instancia_id = ?`)
      .get(instanciaId) as { c: number };
    return linha.c > 0;
  }

  idadeDaCobertura(instanciaId: number): string | null {
    const db = this.metaDb.banco();
    const linha = db
      .prepare(
        `SELECT MIN(atualizado_em) AS mais_antigo
           FROM cobertura WHERE instancia_id = ?`,
      )
      .get(instanciaId) as { mais_antigo: string | null };
    return linha.mais_antigo;
  }

  private lerLote(loteId: number): LinhaLoteEstoque | undefined {
    return this.metaDb
      .banco()
      .prepare(
        `SELECT id, instancia_id, codigo_filial, linhas
           FROM lote WHERE id = ?`,
      )
      .get(loteId) as LinhaLoteEstoque | undefined;
  }
}
