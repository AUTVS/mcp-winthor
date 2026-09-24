import { estimarChars, TtlCache, TtlCacheOpts } from './ttl-cache';

const relogio = () => {
  let agora = 1_000_000;
  return {
    now: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
};

const cache = <T>(over: Partial<TtlCacheOpts> = {}) => {
  const t = relogio();
  return {
    t,
    c: new TtlCache<T>({
      ttlMs: 1_000,
      maxEntries: 3,
      maxChars: 1_000,
      now: t.now,
      ...over,
    }),
  };
};

describe('TtlCache', () => {
  it('serve do cache dentro do TTL e refaz depois', async () => {
    const { t, c } = cache<number[]>();
    let chamadas = 0;
    const carregar = () => {
      chamadas++;
      return Promise.resolve({ valor: [1, 2], chars: 10 });
    };

    expect(await c.getOrLoad('k', carregar)).toEqual([1, 2]);
    expect(await c.getOrLoad('k', carregar)).toEqual([1, 2]);
    expect(chamadas).toBe(1);

    t.avancar(1_001);
    expect(await c.getOrLoad('k', carregar)).toEqual([1, 2]);
    expect(chamadas).toBe(2);
  });

  it('chave vazia desliga o cache', async () => {
    const { c } = cache<number[]>();
    let chamadas = 0;
    const carregar = () => {
      chamadas++;
      return Promise.resolve({ valor: [1], chars: 1 });
    };

    await c.getOrLoad('', carregar);
    await c.getOrLoad('', carregar);
    expect(chamadas).toBe(2);
    expect(c.size).toBe(0);
  });

  it('falha não é cacheada', async () => {
    const { c } = cache<number[]>();
    let chamadas = 0;
    const falhar = () => {
      chamadas++;
      return Promise.resolve(null);
    };

    expect(await c.getOrLoad('k', falhar)).toBeNull();
    expect(await c.getOrLoad('k', falhar)).toBeNull();
    expect(chamadas).toBe(2);
  });

  it('coalesce chamadas concorrentes numa só busca', async () => {
    // Clientes MCP disparam tool calls em paralelo; sem isto, "página 1 e 2 ao
    // mesmo tempo" varreria a base duas vezes.
    const { c } = cache<number[]>();
    let chamadas = 0;
    let liberar: (() => void) | undefined;
    const carregar = async () => {
      chamadas++;
      await new Promise<void>((r) => (liberar = r));
      return { valor: [7], chars: 5 };
    };

    const a = c.getOrLoad('k', carregar);
    const b = c.getOrLoad('k', carregar);
    liberar?.();

    expect(await a).toEqual([7]);
    expect(await b).toEqual([7]);
    expect(chamadas).toBe(1);
  });

  it('rejeição é compartilhada mas não cacheada', async () => {
    const { c } = cache<number[]>();
    let chamadas = 0;
    const explodir = () => {
      chamadas++;
      return Promise.reject(new Error('boom'));
    };

    await expect(c.getOrLoad('k', explodir)).rejects.toThrow('boom');
    await expect(c.getOrLoad('k', explodir)).rejects.toThrow('boom');
    expect(chamadas).toBe(2);
  });

  it('despeja o mais antigo ao passar de maxEntries', async () => {
    const { c } = cache<number[]>();
    const guardar = (k: string) =>
      c.getOrLoad(k, () => Promise.resolve({ valor: [1], chars: 1 }));

    for (const k of ['a', 'b', 'c', 'd']) await guardar(k);

    expect(c.size).toBe(3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toEqual([1]);
  });

  it('despeja por orçamento de chars', async () => {
    const { c } = cache<number[]>({ maxChars: 100 });
    await c.getOrLoad('grande', () =>
      Promise.resolve({ valor: [1], chars: 90 }),
    );
    await c.getOrLoad('outro', () =>
      Promise.resolve({ valor: [2], chars: 90 }),
    );

    // Entradas grandes não são recusadas — apenas empurram as anteriores.
    expect(c.get('grande')).toBeUndefined();
    expect(c.get('outro')).toEqual([2]);
  });

  it('clear zera tudo', async () => {
    const { c } = cache<number[]>();
    await c.getOrLoad('k', () => Promise.resolve({ valor: [1], chars: 1 }));
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('k')).toBeUndefined();
  });

  it('armazenadoEm expõe a idade da entrada', async () => {
    const { c } = cache<number[]>();
    await c.getOrLoad('k', () => Promise.resolve({ valor: [1], chars: 1 }));
    expect(c.armazenadoEm('k')).toBe(new Date(1_000_000).toISOString());
    expect(c.armazenadoEm('inexistente')).toBeUndefined();
  });
});

describe('estimarChars', () => {
  it('extrapola dos primeiros itens em vez de serializar tudo', () => {
    const itens = Array.from({ length: 1000 }, () => ({ a: 'xxxx' }));
    // ~14 chars por item × 1000; precisão não importa para um orçamento.
    expect(estimarChars(itens)).toBeGreaterThan(10_000);
    expect(estimarChars([])).toBe(0);
  });
});
