import { MAX_RESULT_CHARS, PAGE_SIZE_DEFAULT } from '../../config/limits';
import {
  capParaLargura,
  decidirPagina,
  decorar,
  instalarPaginacao,
  LarguraLinha,
  temPaginacao,
} from './pagination';
import { MOBILE_TOOL_LARGURAS, MOBILE_TOOL_NAMES } from './mobile-tools';
import { shapeToolResult, ToolResult } from './tool-result';

const parse = (r: ToolResult) =>
  JSON.parse(r.content[0].text) as Record<string, unknown>;

const paginado = (args: Record<string, unknown>, largura: LarguraLinha) => {
  const d = decidirPagina(args, largura);
  if (!d.paginar) throw new Error('esperava decisão paginada');
  return d;
};

describe('estabilidade de coordenadas', () => {
  // A propriedade que impede o bug das linhas inalcançáveis: pedir 200 devolve
  // 60, e pedir 60 devolve 60 de novo. Se o efetivo derivasse de largura
  // observada em runtime, ele derivaria entre chamadas e as páginas passariam a
  // se sobrepor ou pular linhas.
  it('reduzir é idempotente sob o valor ecoado', () => {
    const primeira = paginado({ page: 1, pageSize: 200 }, 'larga');
    expect(primeira.efetivo).toBe(90);
    expect(primeira.reduzido).toBe(true);

    const seguinte = paginado({ page: 2, pageSize: primeira.efetivo }, 'larga');
    expect(seguinte.efetivo).toBe(90);
    expect(seguinte.reduzido).toBe(false);
  });

  it('caps derivados do orçamento, não hardcoded', () => {
    expect(capParaLargura('estreita')).toBe(200);
    expect(capParaLargura('media')).toBe(150);
    expect(capParaLargura('larga')).toBe(90);
    expect(capParaLargura('enorme')).toBe(20);
  });

  it('não reduz quando o solicitado já cabe', () => {
    const d = paginado({ pageSize: 150 }, 'media');
    expect(d.efetivo).toBe(150);
    expect(d.reduzido).toBe(false);
  });
});

describe('decidirPagina — passagem', () => {
  it('com page e pageSize omitidos, não pagina e não toca nos args', () => {
    // Contrato de wt_mobile_pesquisar_filial: filiaisPadrao() deriva
    // listaFilial da lista COMPLETA. Paginar por padrão estreitaria em
    // silêncio toda consulta W120/W106.
    const args = { matricula: '150' };
    expect(decidirPagina(args, 'larga')).toEqual({ paginar: false });
  });

  it('só page basta para paginar, com pageSize no padrão', () => {
    const d = paginado({ page: 3 }, 'media');
    expect(d.page).toBe(3);
    expect(d.efetivo).toBe(PAGE_SIZE_DEFAULT);
  });
});

describe('temPaginacao', () => {
  const comShape = (shape: Record<string, unknown>) => ({
    inputSchema: { shape },
  });

  it('exige page E pageSize', () => {
    expect(temPaginacao(comShape({ page: 1, pageSize: 1 }))).toBe(true);
    expect(temPaginacao(comShape({ listaFilial: 1 }))).toBe(false);
    expect(temPaginacao(comShape({ page: 1 }))).toBe(false);
  });

  it('tool sem inputSchema nenhum não é paginável', () => {
    // As 4 escalares sem schema são chamadas pelo SDK como (ctx), com o
    // ServerContext em arg0 — embrulhá-las corromperia os argumentos.
    expect(temPaginacao({ title: 'x' })).toBe(false);
    expect(temPaginacao(undefined)).toBe(false);
  });
});

describe('decorar — hasMore e nextPage', () => {
  const envelope = (extra: Record<string, unknown>, linhas = 10) =>
    shapeToolResult({
      ok: true,
      items: Array.from({ length: linhas }, (_, i) => ({ i })),
      ...extra,
    });

  const d = (page: number, efetivo = 10) =>
    paginado({ page, pageSize: efetivo }, 'estreita');

  it('1º: hasNext do upstream vence o total', () => {
    const r = decorar(envelope({ hasNext: false, total: 9999 }), d(1), 't');
    expect(parse(r).hasMore).toBe(false);
    expect(parse(r).nextPage).toBeNull();
  });

  it('2º: total exato quando não há hasNext', () => {
    expect(parse(decorar(envelope({ total: 35 }), d(1), 't')).hasMore).toBe(
      true,
    );
    expect(parse(decorar(envelope({ total: 35 }), d(4), 't')).hasMore).toBe(
      false,
    );
  });

  it('3º: heurística quando não há total nem hasNext', () => {
    expect(parse(decorar(envelope({}, 10), d(1), 't')).hasMore).toBe(true);
    expect(parse(decorar(envelope({}, 4), d(1), 't')).hasMore).toBe(false);
  });

  it('falso positivo da heurística é decisão, não acidente', () => {
    // Última página cheia reporta hasMore:true e a seguinte volta vazia —
    // custa um round-trip. O viés oposto (>) tornaria invisível o sucessor da
    // última página parcial, que é exatamente o bug que isto existe para matar.
    const r = decorar(envelope({}, 10), d(1), 't');
    expect(parse(r).hasMore).toBe(true);
    expect(parse(r).nextPage).toBe(2);
  });

  it('nextPage é null explícito, não chave ausente', () => {
    const parsed = parse(decorar(envelope({ total: 5 }), d(1), 't'));
    expect(parsed).toHaveProperty('nextPage');
    expect(parsed.nextPage).toBeNull();
  });
});

describe('decorar — envelope', () => {
  it('anuncia a redução e preserva o hint que já existia', () => {
    const bruto = shapeToolResult({
      ok: true,
      items: [{ a: 1 }],
      hint: 'Consulta expandida para 7 filiais. Informe listaFilial para reduzir.',
    });
    const parsed = parse(
      decorar(bruto, paginado({ page: 1, pageSize: 200 }, 'larga'), 't'),
    );

    expect(parsed.pageSize).toBe(90);
    expect(parsed.pageSizeSolicitado).toBe(200);
    expect(parsed.hint).toContain('pageSize reduzido de 200 para 90');
    expect(parsed.hint).toContain('7 filiais');
  });

  it('sem redução não polui o envelope', () => {
    const parsed = parse(
      decorar(
        shapeToolResult({ ok: true, items: [{ a: 1 }] }),
        paginado({ page: 1, pageSize: 10 }, 'larga'),
        't',
      ),
    );
    expect(parsed).not.toHaveProperty('pageSizeSolicitado');
    expect(parsed).not.toHaveProperty('hint');
  });

  it('não decora erro, ok:false nem envelope sem array', () => {
    const d = paginado({ page: 1 }, 'larga');
    const erro = shapeToolResult({ ok: false, error: 'x' }, true);
    expect(decorar(erro, d, 't')).toBe(erro);

    const escalar = shapeToolResult({ ok: true, value: 42 });
    expect(decorar(escalar, d, 't')).toBe(escalar);
  });
});

describe('regressão: percorrer as páginas não perde nenhuma linha', () => {
  // Linha W106 realista: larga o bastante para forçar a redução de 200 → 60.
  const LINHAS = Array.from({ length: 300 }, (_, i) => ({
    NUMERO_PEDIDO: 57000000 + i,
    NOME_CLIENTE: `SUPERMERCADO EXEMPLO LTDA ${i}`,
    NOME_FILIAL: 'MATRIZ DISTRIBUIDORA',
    OBSERVACAO: 'x'.repeat(600),
  }));

  /** Handler falso que respeita page/pageSize como o upstream deveria. */
  const buscar = (page: number, pageSize: number): ToolResult => {
    const inicio = (page - 1) * pageSize;
    const items = LINHAS.slice(inicio, inicio + pageSize);
    return shapeToolResult({
      ok: true,
      items,
      count: items.length,
      page,
      pageSize,
      total: LINHAS.length,
    });
  };

  it('a união das páginas é exatamente a fixture — sem buraco, sem duplicata', () => {
    // No desenho antigo esta caminhada pulava as linhas 111-200: pedir 200
    // devolvia 110 truncadas, e page=2 saltava para a linha 201.
    const vistos: number[] = [];
    let page = 1;
    let pageSize = 200; // o cliente pede grande de propósito
    let voltas = 0;

    for (;;) {
      if (++voltas > 20) throw new Error('não convergiu');

      const decisao = paginado({ page, pageSize }, 'larga');
      const bruto = buscar(decisao.page, decisao.efetivo);
      const parsed = parse(decorar(bruto, decisao, 'wt_lucratividade_pedidos'));

      expect(parsed.truncated).toBeUndefined();
      expect(
        (parsed.items as { NUMERO_PEDIDO: number }[]).length,
      ).toBeLessThanOrEqual(decisao.efetivo);

      for (const linha of parsed.items as { NUMERO_PEDIDO: number }[]) {
        vistos.push(linha.NUMERO_PEDIDO);
      }

      if (parsed.hasMore !== true) break;
      // O cliente segue exatamente o que o envelope mandou.
      page = parsed.nextPage as number;
      pageSize = parsed.pageSize as number;
    }

    expect(vistos).toEqual(LINHAS.map((l) => l.NUMERO_PEDIDO));
    expect(new Set(vistos).size).toBe(LINHAS.length);
  });

  it('a primeira página anuncia a redução e cabe no orçamento', () => {
    const decisao = paginado({ page: 1, pageSize: 200 }, 'larga');
    const r = decorar(buscar(1, decisao.efetivo), decisao, 't');

    expect(r.content[0].text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(parse(r)).toMatchObject({
      page: 1,
      pageSize: 90,
      pageSizeSolicitado: 200,
      hasMore: true,
      nextPage: 2,
      total: 300,
    });
  });
});

describe('cobertura do mapa de larguras', () => {
  // O mapa é indexado por string: um typo cairia no padrão em silêncio.
  it('toda tool mobile tem largura, e toda largura tem tool', () => {
    expect(Object.keys(MOBILE_TOOL_LARGURAS).sort()).toEqual(
      [...MOBILE_TOOL_NAMES].sort(),
    );
  });

  it('os grids W120 são estreitos e os W106 largos', () => {
    expect(MOBILE_TOOL_LARGURAS.wt_inadimplencia_por_cliente).toBe('estreita');
    expect(MOBILE_TOOL_LARGURAS.wt_lucratividade_pedidos).toBe('larga');
  });
});

describe('instalarPaginacao', () => {
  type Registro = { name: string; config: unknown; cb: unknown };

  const servidorFalso = () => {
    const registros: Registro[] = [];
    const server = {
      registerTool(name: string, config: unknown, cb: unknown) {
        registros.push({ name, config, cb });
      },
    };
    return { server, registros };
  };

  it('deixa as tools escalares passarem sem embrulho', () => {
    const { server, registros } = servidorFalso();
    instalarPaginacao(server, {});
    const handler = () => shapeToolResult({ ok: true });

    server.registerTool('wt_ping', { title: 'p' }, handler);

    // Identidade por referência: nada foi interposto.
    expect(registros[0].cb).toBe(handler);
  });

  it('embrulha quem tem page e pageSize', () => {
    const { server, registros } = servidorFalso();
    instalarPaginacao(server, {});
    const handler = () => shapeToolResult({ ok: true });

    server.registerTool(
      'wt_x',
      { inputSchema: { shape: { page: 1, pageSize: 1 } } },
      handler,
    );

    expect(registros[0].cb).not.toBe(handler);
  });

  it('o handler embrulhado recebe o pageSize efetivo, não o solicitado', async () => {
    const { server, registros } = servidorFalso();
    instalarPaginacao(server, { wt_x: 'larga' });
    const recebidos: Record<string, unknown>[] = [];

    server.registerTool(
      'wt_x',
      { inputSchema: { shape: { page: 1, pageSize: 1 } } },
      (args: Record<string, unknown>) => {
        recebidos.push(args);
        return shapeToolResult({ ok: true, items: [] });
      },
    );

    const cb = registros[0].cb as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
    await cb({ page: 1, pageSize: 200 });

    expect(recebidos[0].pageSize).toBe(90);
  });
});
