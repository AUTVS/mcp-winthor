import { Injectable, Logger } from '@nestjs/common';
import { TOLERANCIA_CONFERENCIA_PCT } from '../config/limits';
import { ORDEM_FILIAL } from './cobertura';
import { executarParams, consultar } from './duckdb';
import { upsertDimensao } from './vendas-dimensao';
import {
  Dia,
  diaDoPedido,
  diaNoErp,
  diasEntre,
  dentroDaJanela,
  Janela,
  janelaQuente,
} from './periodo-janela';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';

/**
 * Escrita na base local de vendas.
 *
 * A unidade de trabalho é o **lote** = (filial × período × posição). Dimensões
 * vão para SQLite meta; fatos para DuckDB.
 */

export type EstadoLote = 'em_andamento' | 'completo' | 'parcial' | 'falhou';

export interface NovoLote {
  instanciaId: number;
  codigoFilial: string;
  periodo: string;
  posicaoPedido: string;
  margemMinLucro: string;
  janela: Janela;
}

export interface FechamentoLote {
  estado: Exclude<EstadoLote, 'em_andamento'>;
  paginas: number;
  totalUpstream?: number;
  valorUpstream?: number;
  custoUpstream?: number;
  motivo?: string;
  agora?: Date;
}

export interface ResultadoFechamento {
  estado: EstadoLote;
  linhas: number;
  removidos: number;
  valorLocal: number;
  valorUpstream?: number;
  divergenciaPct?: number;
  confere?: boolean;
  diasCobertos: number;
}

function numero(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor.trim())) {
    return Number(valor);
  }
  return null;
}

function inteiro(valor: unknown): number | null {
  const n = numero(valor);
  return n === null ? null : Math.trunc(n);
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor)
    : null;
}

@Injectable()
export class VendasStoreService {
  private readonly logger = new Logger(VendasStoreService.name);

  constructor(
    private readonly metaDb: VendasMetaDbService,
    private readonly fatoDb: VendasFatoDbService,
  ) {}

  abrirLote(lote: NovoLote): number {
    const db = this.metaDb.banco();
    db.prepare(
      `INSERT INTO lote (instancia_id, codigo_filial, periodo, posicao_pedido,
                         margem_min_lucro, dia_inicio, dia_fim, iniciado_em, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'em_andamento')`,
    ).run(
      lote.instanciaId,
      lote.codigoFilial,
      lote.periodo,
      lote.posicaoPedido,
      lote.margemMinLucro,
      lote.janela.dataInicio,
      lote.janela.dataFim,
      new Date().toISOString(),
    );

    const linha = db.prepare('SELECT last_insert_rowid() AS id').get() as {
      id: number;
    };
    return linha.id;
  }

  async gravarPagina(
    loteId: number,
    pedidos: Record<string, unknown>[],
    proximaPagina: number,
  ): Promise<{ gravados: number; semDia: number; diaSuspeito: number }> {
    const meta = this.metaDb.banco();
    const lote = this.lerLote(loteId);
    if (!lote) throw new Error(`lote ${loteId} não existe`);

    const agora = new Date().toISOString();
    let gravados = 0;
    let semDia = 0;
    let diaSuspeito = 0;
    const fatos: unknown[][] = [];

    meta.exec('BEGIN');
    try {
      for (const pedido of pedidos) {
        const numeroPedido = texto(pedido.NUMERO_PEDIDO);
        const derivado = diaDoPedido(pedido.DATA_PEDIDO);

        if (numeroPedido === null || derivado === null) {
          semDia++;
          continue;
        }
        if (!derivado.confiavel) diaSuspeito++;

        const dimFilialId = upsertDimensao(
          meta,
          'dim_filial',
          lote.instancia_id,
          lote.codigo_filial,
          texto(pedido.NOME_FILIAL),
          agora,
        );

        const codigoCliente = texto(pedido.CODIGO_CLIENTE);
        const dimClienteId = codigoCliente
          ? upsertDimensao(
              meta,
              'dim_cliente',
              lote.instancia_id,
              codigoCliente,
              texto(pedido.NOME_CLIENTE),
              agora,
            )
          : null;

        const codigoRca = texto(pedido.CODIGO_RCA);
        const dimRcaId = codigoRca
          ? upsertDimensao(
              meta,
              'dim_rca',
              lote.instancia_id,
              codigoRca,
              texto(pedido.NOME_RCA),
              agora,
            )
          : null;

        const codigoEmitente = texto(pedido.CODIGO_EMITENTE);
        const dimEmitenteId = codigoEmitente
          ? upsertDimensao(
              meta,
              'dim_emitente',
              lote.instancia_id,
              codigoEmitente,
              texto(pedido.NOME_EMITENTE),
              agora,
            )
          : null;

        fatos.push([
          lote.instancia_id,
          lote.codigo_filial,
          numeroPedido,
          derivado.dia,
          String(pedido.DATA_PEDIDO),
          inteiro(pedido.HORA),
          inteiro(pedido.MINUTO),
          texto(pedido.POSICAO_PEDIDO),
          texto(pedido.TIPO_VENDA),
          dimFilialId,
          dimClienteId,
          dimRcaId,
          dimEmitenteId,
          texto(pedido.CODIGO_COBRANCA),
          texto(pedido.NUMERO_NOTA),
          numero(pedido.VALOR_PEDIDO) ?? 0,
          numero(pedido.VALOR_ATENDIDO),
          numero(pedido.CUSTO_FINANCEIRO),
          numero(pedido.PERCENTUAL_LUCRO),
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
      const sql = `INSERT OR REPLACE INTO pedido (
        instancia_id, codigo_filial, numero_pedido, dia, data_pedido, hora, minuto,
        posicao_pedido, tipo_venda, dim_filial_id, dim_cliente_id, dim_rca_id,
        dim_emitente_id, codigo_cobranca, numero_nota, valor_pedido, valor_atendido,
        custo_financeiro, percentual_lucro, lote_id, ingerido_em
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

      for (const params of fatos) {
        await executarParams(fato, sql, params as never[]);
      }
    }

    return { gravados, semDia, diaSuspeito };
  }

  async fecharLote(
    loteId: number,
    f: FechamentoLote,
  ): Promise<ResultadoFechamento> {
    const meta = this.metaDb.banco();
    const lote = this.lerLote(loteId);
    if (!lote) throw new Error(`lote ${loteId} não existe`);

    const janela: Janela = {
      dataInicio: lote.dia_inicio,
      dataFim: lote.dia_fim,
    };
    const agora = f.agora ?? new Date();
    const concluidoEm = agora.toISOString();

    if (f.estado !== 'completo') {
      meta
        .prepare(
          `UPDATE lote SET estado = ?, concluido_em = ?, paginas = ?, motivo = ?
          WHERE id = ?`,
        )
        .run(f.estado, concluidoEm, f.paginas, f.motivo ?? null, loteId);
      this.logger.warn(
        `lote ${loteId} (filial ${lote.codigo_filial}, periodo ${lote.periodo}) ` +
          `terminou como ${f.estado}: ${f.motivo ?? 'sem motivo declarado'}. ` +
          `Cobertura não publicada.`,
      );
      return {
        estado: f.estado,
        linhas: lote.linhas,
        removidos: 0,
        valorLocal: 0,
        diasCobertos: 0,
      };
    }

    const fato = await this.fatoDb.conexao();

    await executarParams(
      fato,
      `DELETE FROM pedido
        WHERE instancia_id = ? AND codigo_filial = ?
          AND dia BETWEEN ? AND ? AND lote_id <> ?`,
      [
        lote.instancia_id,
        lote.codigo_filial,
        janela.dataInicio,
        janela.dataFim,
        loteId,
      ],
    );

    const localRows = await consultar<{ qt: number; valor: number }>(
      fato,
      `SELECT COUNT(*) AS qt, COALESCE(SUM(valor_pedido), 0) AS valor
         FROM pedido
        WHERE instancia_id = ? AND codigo_filial = ? AND dia BETWEEN ? AND ?`,
      [
        lote.instancia_id,
        lote.codigo_filial,
        janela.dataInicio,
        janela.dataFim,
      ],
    );
    const local = localRows[0] ?? { qt: 0, valor: 0 };

    const divergenciaPct =
      f.valorUpstream !== undefined && f.valorUpstream !== 0
        ? ((Number(local.valor) - f.valorUpstream) / f.valorUpstream) * 100
        : undefined;
    const confere =
      divergenciaPct === undefined
        ? undefined
        : Math.abs(divergenciaPct) <= TOLERANCIA_CONFERENCIA_PCT;

    if (confere === false) {
      this.logger.error(
        `conferência falhou no lote ${loteId} (filial ${lote.codigo_filial}, ` +
          `periodo ${lote.periodo}): local ${local.valor} vs upstream ` +
          `${String(f.valorUpstream)} (${divergenciaPct?.toFixed(2)}%).`,
      );
    }

    meta.exec('BEGIN');
    try {
      meta
        .prepare(
          `UPDATE lote SET estado = ?, concluido_em = ?, paginas = ?, motivo = ?,
                         total_upstream = ?, valor_upstream = ?, custo_upstream = ?,
                         qt_local = ?, valor_local = ?, divergencia_pct = ?,
                         confere = ?, removidos = ?
          WHERE id = ?`,
        )
        .run(
          confere === false ? 'parcial' : 'completo',
          concluidoEm,
          f.paginas,
          f.motivo ?? null,
          f.totalUpstream ?? null,
          f.valorUpstream ?? null,
          f.custoUpstream ?? null,
          Number(local.qt),
          Number(local.valor),
          divergenciaPct ?? null,
          confere === undefined ? null : confere ? 1 : 0,
          0,
          loteId,
        );

      const diasCobertos =
        confere === false
          ? 0
          : await this.publicarCobertura(
              loteId,
              lote,
              janela,
              agora,
              concluidoEm,
            );

      meta.exec('COMMIT');
      return {
        estado: confere === false ? 'parcial' : 'completo',
        linhas: Number(local.qt),
        removidos: 0,
        valorLocal: Number(local.valor),
        valorUpstream: f.valorUpstream,
        divergenciaPct,
        confere,
        diasCobertos,
      };
    } catch (err) {
      meta.exec('ROLLBACK');
      throw err;
    }
  }

  private async publicarCobertura(
    loteId: number,
    lote: LinhaLote,
    janela: Janela,
    agora: Date,
    concluidoEm: string,
  ): Promise<number> {
    const meta = this.metaDb.banco();
    const fato = await this.fatoDb.conexao();
    const quente = janelaQuente(agora);

    const porDia = new Map<Dia, { qt: number; valor: number }>();
    for (const linha of await consultar<{
      dia: string;
      qt: number;
      valor: number;
    }>(
      fato,
      `SELECT CAST(dia AS VARCHAR) AS dia, COUNT(*) AS qt,
              COALESCE(SUM(valor_pedido), 0) AS valor
         FROM pedido
        WHERE instancia_id = ? AND codigo_filial = ? AND dia BETWEEN ? AND ?
        GROUP BY dia`,
      [
        lote.instancia_id,
        lote.codigo_filial,
        janela.dataInicio,
        janela.dataFim,
      ],
    )) {
      porDia.set(linha.dia, {
        qt: Number(linha.qt),
        valor: Number(linha.valor),
      });
    }

    const gravar = meta.prepare(
      `INSERT INTO cobertura (instancia_id, codigo_filial, dia, posicao_pedido,
                              lote_id, atualizado_em, qt_pedidos, valor, estado)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(instancia_id, codigo_filial, dia, posicao_pedido) DO UPDATE SET
         lote_id = excluded.lote_id, atualizado_em = excluded.atualizado_em,
         qt_pedidos = excluded.qt_pedidos, valor = excluded.valor,
         estado = excluded.estado`,
    );

    const hoje = diaNoErp(agora);
    const fim = janela.dataFim < hoje ? janela.dataFim : hoje;
    const dias = diasEntre(janela.dataInicio, fim);

    for (const dia of dias) {
      const totais = porDia.get(dia) ?? { qt: 0, valor: 0 };
      const estado = dentroDaJanela(dia, quente) ? 'quente' : 'frio';
      gravar.run(
        lote.instancia_id,
        lote.codigo_filial,
        dia,
        lote.posicao_pedido,
        loteId,
        concluidoEm,
        totais.qt,
        totais.valor,
        estado,
      );
    }
    return dias.length;
  }

  aprenderPosicoes(instanciaId: number, mapa: Record<string, string>): void {
    const db = this.metaDb.banco();
    const gravar = db.prepare(
      `INSERT INTO dim_posicao (instancia_id, codigo, rotulo, aprendido_em)
       VALUES (?,?,?,?)
       ON CONFLICT(instancia_id, codigo) DO UPDATE SET
         rotulo = excluded.rotulo, aprendido_em = excluded.aprendido_em`,
    );
    const agora = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const [codigo, rotulo] of Object.entries(mapa)) {
        gravar.run(instanciaId, codigo, rotulo, agora);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Fecha lotes que ficaram `em_andamento` de um processo morto.
   *
   * Chamado no boot, onde a inferência é exata: nenhuma varredura deste processo
   * começou ainda, então todo lote `em_andamento` pertence a um processo que não
   * existe mais — kill, crash ou queda de energia no meio da varredura. Nada os
   * reaproveitava nem os expirava, e eles ficavam para sempre inflando a lista de
   * "lotes com problema" sem que nada pudesse resolvê-los.
   *
   * Vira `falhou` e não `parcial` de propósito: `parcial` significa "varreu e não
   * fechou a conferência", uma afirmação sobre o dado. Aqui não se sabe nada sobre
   * o dado — só que ninguém terminou de olhar.
   */
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
      `${orfaos} lote(s) ficaram em_andamento de um processo anterior; ` +
        `marcados como falhou. A cobertura deles não foi publicada.`,
    );
    return orfaos;
  }

  /**
   * Registra o conjunto de filiais que a base passa a considerar esperado.
   *
   * Mesma disciplina de `aprenderPosicoes`: o que se aprendeu do ERP fica gravado, e
   * o resto do sistema lê local. O status é consultado em poll de 1,5 s durante a
   * sincronização — perguntar `filiaisPadrao()` ali seriam duas chamadas HTTP por
   * poll, e o painel travaria junto com o ERP.
   *
   * **Substitui em vez de unir**: filial removida da visibilidade do usuário tem de
   * sumir da expectativa, senão a base fica "parcial" para sempre por causa de uma
   * filial que não existe mais.
   */
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
        if (codigo.length) gravar.run(instanciaId, codigo, carimbo);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Filiais esperadas para medir cobertura.
   *
   * Cai para as que já têm cobertura enquanto nenhuma varredura padrão rodou nesta
   * build — é o comportamento otimista de antes, e `fonte` deixa isso legível na UI
   * em vez de fingir certeza. `verificarVencimento` conserta sozinho no próximo ciclo.
   */
  filiaisEsperadas(instanciaId: number): {
    filiais: string[];
    fonte: 'sync' | 'cobertura';
  } {
    const db = this.metaDb.banco();

    const alvo = db
      .prepare(
        `SELECT codigo_filial FROM filial_alvo
          WHERE instancia_id = ? ORDER BY ${ORDEM_FILIAL}`,
      )
      .all(instanciaId) as { codigo_filial: string }[];
    if (alvo.length) {
      return { filiais: alvo.map((l) => l.codigo_filial), fonte: 'sync' };
    }

    const vistas = db
      .prepare(
        `SELECT DISTINCT codigo_filial FROM cobertura
          WHERE instancia_id = ? ORDER BY ${ORDEM_FILIAL}`,
      )
      .all(instanciaId) as { codigo_filial: string }[];
    return { filiais: vistas.map((l) => l.codigo_filial), fonte: 'cobertura' };
  }

  idadeDaJanelaQuente(instanciaId: number, agora = new Date()): string | null {
    const quente = janelaQuente(agora);
    const linha = this.metaDb
      .banco()
      .prepare(
        `SELECT MIN(atualizado_em) AS mais_antigo
           FROM cobertura
          WHERE instancia_id = ? AND dia BETWEEN ? AND ?`,
      )
      .get(instanciaId, quente.dataInicio, quente.dataFim) as {
      mais_antigo: string | null;
    };
    return linha.mais_antigo;
  }

  temCobertura(instanciaId: number): boolean {
    const linha = this.metaDb
      .banco()
      .prepare('SELECT COUNT(*) AS c FROM cobertura WHERE instancia_id = ?')
      .get(instanciaId) as { c: number };
    return linha.c > 0;
  }

  async expurgar(
    instanciaId: number,
    anos: number,
    agora = new Date(),
  ): Promise<number> {
    const meta = this.metaDb.banco();
    const anoLimite = Number(diaNoErp(agora).slice(0, 4)) - (anos - 1);
    const corte = `${anoLimite}-01-01`;

    const fato = await this.fatoDb.conexao();
    await executarParams(
      fato,
      'DELETE FROM pedido WHERE instancia_id = ? AND dia < ?',
      [instanciaId, corte],
    );

    meta.exec('BEGIN');
    try {
      meta
        .prepare('DELETE FROM cobertura WHERE instancia_id = ? AND dia < ?')
        .run(instanciaId, corte);
      meta.exec('COMMIT');
    } catch (err) {
      meta.exec('ROLLBACK');
      throw err;
    }

    meta.exec('VACUUM');
    this.logger.log(`expurgo: pedidos anteriores a ${corte} removidos.`);
    return 0;
  }

  marcarDiaVerificado(instanciaId: number, agora = new Date()): void {
    this.metaDb
      .banco()
      .prepare('UPDATE instancia SET dia_verificado_em = ? WHERE id = ?')
      .run(agora.toISOString(), instanciaId);
  }

  marcarCoberturaSuspeita(
    instanciaId: number,
    codigoFilial: string,
    janela: Janela,
  ): void {
    this.metaDb
      .banco()
      .prepare(
        `UPDATE cobertura SET estado = 'suspeito'
          WHERE instancia_id = ? AND codigo_filial = ?
            AND dia BETWEEN ? AND ? AND estado = 'frio'`,
      )
      .run(instanciaId, codigoFilial, janela.dataInicio, janela.dataFim);
  }

  private lerLote(loteId: number): LinhaLote | undefined {
    return this.metaDb
      .banco()
      .prepare(
        `SELECT id, instancia_id, codigo_filial, periodo, posicao_pedido,
                dia_inicio, dia_fim, linhas
           FROM lote WHERE id = ?`,
      )
      .get(loteId) as LinhaLote | undefined;
  }
}

interface LinhaLote {
  id: number;
  instancia_id: number;
  codigo_filial: string;
  periodo: string;
  posicao_pedido: string;
  dia_inicio: string;
  dia_fim: string;
  linhas: number;
}
