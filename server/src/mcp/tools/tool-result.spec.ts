import { MAX_RESULT_CHARS } from '../../config/limits';
import { shapeToolResult, toToolResult } from './tool-result';
import { WinthorApiResult } from '../../winthor/winthor-api.service';

/** Linha larga o suficiente para estourar o orçamento com poucas centenas. */
function linha(i: number): Record<string, unknown> {
  return {
    NUMERO_PEDIDO: String(100000 + i),
    NOME_CLIENTE: `CLIENTE COM RAZAO SOCIAL LONGA LTDA ${i}`,
    NOME_FILIAL: 'MATRIZ DISTRIBUIDORA',
    VALOR_PEDIDO: 1234.56 + i,
    PERC_LUCRO: 12.34,
    OBSERVACAO: 'x'.repeat(200),
  };
}

const texto = (r: { content: { text: string }[] }) => r.content[0].text;
const parse = (r: { content: { text: string }[] }) =>
  JSON.parse(texto(r)) as Record<string, unknown>;

describe('shapeToolResult', () => {
  it('serializa compacto, sem pretty-print', () => {
    const r = shapeToolResult({ ok: true, items: [{ a: 1 }, { b: 2 }] });

    expect(texto(r)).not.toContain('\n');
    expect(texto(r)).toBe('{"ok":true,"items":[{"a":1},{"b":2}]}');
  });

  it('dentro do orçamento devolve o envelope intacto', () => {
    const payload = {
      ok: true,
      count: 2,
      page: 1,
      items: [linha(1), linha(2)],
    };
    const parsed = parse(shapeToolResult(payload));

    expect(parsed).not.toHaveProperty('truncated');
    expect(parsed).not.toHaveProperty('returned');
    expect(parsed).not.toHaveProperty('hint');
    expect((parsed.items as unknown[]).length).toBe(2);
    expect(parsed.count).toBe(2);
  });

  it('acima do orçamento corta e manda repetir a MESMA página, nunca a próxima', () => {
    const items = Array.from({ length: 400 }, (_, i) => linha(i));
    const r = shapeToolResult({
      ok: true,
      count: items.length,
      page: 1,
      pageSize: 400,
      total: 3480,
      items,
    });
    const parsed = parse(r);
    const mantidas = parsed.items as unknown[];

    expect(texto(r).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(mantidas.length).toBeGreaterThan(0);
    expect(mantidas.length).toBeLessThan(items.length);
    expect(parsed.truncated).toBe(true);
    expect(parsed.returned).toBe(mantidas.length);
    // `count` é "linhas nesta resposta" — precisa acompanhar o corte.
    expect(parsed.count).toBe(mantidas.length);
    // `total` é do upstream e continua verdadeiro.
    expect(parsed.total).toBe(3480);
    // Mandar pedir page=2 aqui tornaria as linhas descartadas inalcançáveis:
    // o upstream saltaria por cima delas. O único conselho correto é repetir.
    expect(parsed.hint).toContain(`pageSize=${mantidas.length}`);
    expect(parsed.hint).not.toContain('page=2');

    // O requisito central: truncar não é falha.
    expect(r.isError).toBe(false);
  });

  it('anexa a dica específica da tool ao aviso de truncamento', () => {
    const items = Array.from({ length: 400 }, (_, i) => linha(i));
    const parsed = parse(
      shapeToolResult(
        { ok: true, page: 1, items },
        false,
        'Filtros: listaFilial, periodo.',
      ),
    );

    expect(parsed.hint).toContain('Filtros: listaFilial, periodo.');
  });

  it('acha o array mesmo sob outra chave (filiais, clientes, pedidos)', () => {
    const clientes = Array.from({ length: 400 }, (_, i) => linha(i));
    const parsed = parse(shapeToolResult({ ok: true, clientes }));

    expect(parsed.truncated).toBe(true);
    expect((parsed.clientes as unknown[]).length).toBeLessThan(clientes.length);
    // A chave original é preservada — nada vira `items` no meio do caminho.
    expect(parsed).not.toHaveProperty('items');
  });

  it('envelopa array cru e escalar', () => {
    expect(parse(shapeToolResult([{ a: 1 }])).items).toEqual([{ a: 1 }]);
    expect(parse(shapeToolResult('pong')).value).toBe('pong');
  });

  it('sem array para cortar, degrada para preview e continua JSON válido', () => {
    const r = shapeToolResult({
      ok: true,
      blob: 'x'.repeat(MAX_RESULT_CHARS * 2),
    });
    const parsed = parse(r);

    expect(texto(r).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe('string');
    expect(r.isError).toBe(false);
  });

  it('uma única linha maior que o orçamento devolve zero linhas, não lixo', () => {
    const r = shapeToolResult({
      ok: true,
      page: 1,
      items: [{ enorme: 'x'.repeat(MAX_RESULT_CHARS * 2) }],
    });
    const parsed = parse(r);

    expect(texto(r).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.returned).toBe(0);
    expect(r.isError).toBe(false);
  });
});

describe('toToolResult', () => {
  it('preserva o envelope de erro e marca isError', () => {
    const erro: WinthorApiResult<unknown> = {
      ok: false,
      status: 500,
      error: 'WinThor retornou 500',
      raw: '<html>stack</html>',
    };
    const r = toToolResult(erro);
    const parsed = parse(r);

    expect(r.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(500);
    expect(parsed.error).toBe('WinThor retornou 500');
    expect(parsed.raw).toBe('<html>stack</html>');
  });

  it('espalha o GridResult no envelope de sucesso', () => {
    const r = toToolResult({
      ok: true,
      status: 200,
      data: { items: [{ a: 1 }], count: 1, page: 1, pageSize: 10, total: 42 },
    });
    const parsed = parse(r);

    expect(r.isError).toBe(false);
    expect(parsed).toMatchObject({ ok: true, count: 1, total: 42 });
    expect(parsed.items).toEqual([{ a: 1 }]);
  });

  it('trata data array e data escalar sem caso especial', () => {
    expect(
      parse(toToolResult({ ok: true, status: 200, data: [{ a: 1 }] })).items,
    ).toEqual([{ a: 1 }]);
    expect(
      parse(toToolResult({ ok: true, status: 200, data: null })).value,
    ).toBeNull();
  });
});
