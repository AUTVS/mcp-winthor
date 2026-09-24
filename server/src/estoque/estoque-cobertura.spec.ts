import { medirCoberturaEstoque } from './estoque-cobertura';
import { EstoqueMetaDbService } from './estoque-meta-db.service';
import { WtConfigService } from '../config/wt-config.service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('estoque-cobertura', () => {
  let dir: string;
  let meta: EstoqueMetaDbService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-estoque-cob-'));
    process.env.WTA_DATA_DIR = dir;
    meta = new EstoqueMetaDbService({
      getConfig: () => ({
        winthorBaseUrl: 'http://winthor.local:8181',
        login: 'DEMO',
        senhaMd5: 'X',
        configuredAt: '2026-01-01T00:00:00.000Z',
      }),
    } as WtConfigService);
    meta.instanciaId();
  });

  afterEach(() => {
    meta.fechar();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mede cobertura por filial', () => {
    const instanciaId = meta.instanciaId()!;
    const db = meta.banco();
    const loteId = db
      .prepare(
        `INSERT INTO lote (instancia_id, codigo_filial, iniciado_em, estado)
         VALUES (?, '1', '2026-01-01', 'completo')`,
      )
      .run(instanciaId).lastInsertRowid;

    db.prepare(
      `INSERT INTO cobertura (instancia_id, codigo_filial, lote_id, atualizado_em, qt_produtos, estado)
       VALUES (?, '1', ?, '2026-01-02', 10, 'ok')`,
    ).run(instanciaId, loteId);

    const resumo = medirCoberturaEstoque(db, instanciaId, ['1', '2']);
    expect(resumo.completa).toBe(false);
    expect(resumo.filiaisCobertas).toBe(1);
    expect(resumo.faltantes).toEqual(['2']);
  });
});
