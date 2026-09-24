import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coberturaPorMes,
  filiaisComCobertura,
  medirCobertura,
  motivoCoberturaIncompleta,
} from './cobertura';
import { criarBasesTeste } from './vendas-test-helpers';

const JANELA = { dataInicio: '2026-06-01', dataFim: '2026-06-30' };
const AGORA = new Date('2026-09-15T15:00:00.000Z');

const pedido = (over: Record<string, unknown> = {}) => ({
  NUMERO_PEDIDO: 1,
  CODIGO_FILIAL: '1',
  NOME_FILIAL: 'MATRIZ',
  DATA_PEDIDO: '2026-06-10T03:00:00.000Z',
  POSICAO_PEDIDO: 'FATURADO',
  CODIGO_CLIENTE: 331,
  NOME_CLIENTE: 'GILMARIO',
  CODIGO_RCA: 57,
  NOME_RCA: 'ORLANO',
  CODIGO_EMITENTE: 83,
  NOME_EMITENTE: 'ORLANO',
  VALOR_PEDIDO: 1000,
  CUSTO_FINANCEIRO: 600,
  PERCENTUAL_LUCRO: 40,
  ...over,
});

describe('cobertura', () => {
  let dir: string;
  let bases: Awaited<ReturnType<typeof criarBasesTeste>>;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-cobertura-'));
    process.env.WTA_DATA_DIR = dir;
    bases = await criarBasesTeste();
    bases.store.aprenderPosicoes(bases.instanciaId, { '4': 'FATURADO' });
  });

  afterEach(async () => {
    await bases.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  const ingerir = async (
    filial: string,
    pedidos: Record<string, unknown>[] = [],
    janela = JANELA,
    agora = AGORA,
  ) => {
    const lote = bases.store.abrirLote({
      instanciaId: bases.instanciaId,
      codigoFilial: filial,
      periodo: '4',
      posicaoPedido: '0',
      margemMinLucro: '100',
      janela,
    });
    if (pedidos.length) await bases.store.gravarPagina(lote, pedidos, 2);
    await bases.store.fecharLote(lote, {
      estado: 'completo',
      paginas: 1,
      agora,
    });
  };

  const medir = (filiais: string[], janela = JANELA) =>
    medirCobertura(bases.meta.banco(), {
      instanciaId: bases.instanciaId,
      janela,
      filiais,
    });

  it('uma filial de duas deixa a janela incompleta', async () => {
    // ESTE é o bug. O endpoint de status contava `DISTINCT dia` e devolvia
    // "Cacheado" nesta exata situação, enquanto a consulta recusava a janela.
    await ingerir('1');

    const r = medir(['1', '2']);
    expect(r.completa).toBe(false);
    expect(r.dias).toBe(30);
    expect(r.paresEsperados).toBe(60);
    expect(r.paresCobertos).toBe(30);
    expect(r.faltantes).toHaveLength(30);
    expect(r.diasCompletos).toBe(0);
  });

  it('as duas filiais cobertas fecham a janela', async () => {
    await ingerir('1');
    await ingerir('2');

    const r = medir(['1', '2']);
    expect(r.completa).toBe(true);
    expect(r.paresCobertos).toBe(60);
    expect(r.faltantes).toEqual([]);
    expect(r.diasCompletos).toBe(30);
  });

  it('sem filial esperada a janela é indeterminada, não completa', () => {
    // Devolver `completa: true` para conjunto vazio é a regressão que faria o
    // painel voltar a mentir na primeira subida, antes de qualquer varredura.
    const r = medir([]);
    expect(r.completa).toBe(false);
    expect(r.paresEsperados).toBe(0);
    expect(r.faltantes).toHaveLength(30);
  });

  it('janela invertida não afirma nada', () => {
    const r = medir(['1'], { dataInicio: '2026-06-30', dataFim: '2026-06-01' });
    expect(r.dias).toBe(0);
    expect(r.completa).toBe(false);
  });

  it('filial fora do alvo não compensa outra faltando', async () => {
    // Duas filiais varridas, mas o alvo pede uma terceira: continua incompleta,
    // e `paresCobertos` não pode estourar `paresEsperados`.
    await ingerir('1');
    await ingerir('2');

    const r = medir(['1', '3']);
    expect(r.completa).toBe(false);
    expect(r.paresCobertos).toBe(30);
    expect(r.paresCobertos).toBeLessThanOrEqual(r.paresEsperados);
  });

  it('cobertura parcial da janela reporta os dias que faltam', async () => {
    await ingerir('1', [], { dataInicio: '2026-06-01', dataFim: '2026-06-15' });

    const r = medir(['1']);
    expect(r.completa).toBe(false);
    expect(r.diasCompletos).toBe(15);
    expect(r.faltantes).toHaveLength(15);
    expect(r.faltantes[0]).toBe('2026-06-16');
  });

  it('atualizadoEm é o MIN da janela — a defasagem, não a última escrita', async () => {
    await ingerir(
      '1',
      [],
      { dataInicio: '2026-06-01', dataFim: '2026-06-15' },
      new Date('2026-09-10T15:00:00.000Z'),
    );
    await ingerir(
      '1',
      [],
      { dataInicio: '2026-06-16', dataFim: '2026-06-30' },
      new Date('2026-09-20T15:00:00.000Z'),
    );

    const r = medir(['1']);
    expect(r.completa).toBe(true);
    expect(r.atualizadoEm?.slice(0, 10)).toBe('2026-09-10');
  });

  it('dia sem venda conta como coberto', async () => {
    await ingerir('1', [pedido()]);
    const r = medir(['1']);
    expect(r.completa).toBe(true);
    expect(r.diasCompletos).toBe(30);
  });

  it('motivoCoberturaIncompleta mantém a frase que viaja no MCP', async () => {
    await ingerir('1');
    const r = medir(['1', '2']);
    expect(motivoCoberturaIncompleta(r)).toBe(
      'base local cobre 30 de 60 pares (dia × filial); 30 dia(s) sem cobertura completa',
    );
  });

  it('filiaisComCobertura lista só quem tem linha na janela', async () => {
    await ingerir('1');
    await ingerir('2');
    expect(
      filiaisComCobertura(bases.meta.banco(), bases.instanciaId, JANELA),
    ).toEqual(['1', '2']);
  });

  describe('coberturaPorMes', () => {
    it('recorta o primeiro e o último mês pela janela', async () => {
      const janela = { dataInicio: '2026-05-20', dataFim: '2026-07-10' };
      await ingerir('1', [], janela);

      const meses = coberturaPorMes(bases.meta.banco(), {
        instanciaId: bases.instanciaId,
        janela,
        filiais: ['1'],
      });

      expect(meses.map((m) => m.mes)).toEqual([
        '2026-07',
        '2026-06',
        '2026-05',
      ]);
      // Maio começa no dia 20 e julho termina no dia 10: nenhum dos dois é mês cheio.
      expect(meses.find((m) => m.mes === '2026-05')?.diasEsperados).toBe(12);
      expect(meses.find((m) => m.mes === '2026-06')?.diasEsperados).toBe(30);
      expect(meses.find((m) => m.mes === '2026-07')?.diasEsperados).toBe(10);
    });

    it('só conta dia coberto quando todas as filiais esperadas o têm', async () => {
      await ingerir('1');

      const meses = coberturaPorMes(bases.meta.banco(), {
        instanciaId: bases.instanciaId,
        janela: JANELA,
        filiais: ['1', '2'],
      });

      expect(meses[0].diasEsperados).toBe(30);
      expect(meses[0].diasCobertos).toBe(0);
      expect(meses[0].filiais).toBe(1);
    });

    it('vem do mês mais recente para o mais antigo', async () => {
      const janela = { dataInicio: '2026-04-01', dataFim: '2026-06-30' };
      await ingerir('1', [], janela);
      const meses = coberturaPorMes(bases.meta.banco(), {
        instanciaId: bases.instanciaId,
        janela,
        filiais: ['1'],
      });
      expect(meses.map((m) => m.mes)).toEqual([
        '2026-06',
        '2026-05',
        '2026-04',
      ]);
    });
  });

  describe('acoplamento com VendasQueryService', () => {
    // O teste que impede o bug de renascer: se o predicado e a consulta puderem
    // divergir de novo, é aqui que aparece — antes de virar card verde mentindo.
    const casos: [string, string[]][] = [
      ['uma filial coberta, uma esperada', ['1']],
      ['uma filial coberta, duas esperadas', ['1', '2']],
      ['nenhuma filial esperada', []],
    ];

    it.each(casos)(
      '%s: medirCobertura concorda com agregar',
      async (_nome, filiais) => {
        await ingerir('1', [pedido()]);

        const resumo = medir(filiais);
        const r = await bases.query.agregar({
          dimensao: 'cliente',
          filiais,
          janela: JANELA,
          posicaoPedido: '0',
        });

        expect(resumo.completa).toBe(r.atendivel);
        if (!r.atendivel && filiais.length) {
          expect(r.diasFaltantes?.length).toBe(resumo.faltantes.length);
        }
      },
    );
  });
});
