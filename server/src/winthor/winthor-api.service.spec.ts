import { WinthorApiService } from './winthor-api.service';
import { WinthorAuthService } from './winthor-auth.service';
import { WtConfigService } from '../config/wt-config.service';
import { REQUEST_TIMEOUT_MS } from '../config/limits';

const configStub = {
  getConfig: () => ({
    winthorBaseUrl: 'http://winthor.local:8181',
    login: 'DEMO',
    senhaMd5: 'X',
    configuredAt: '2026-01-01T00:00:00.000Z',
  }),
} as unknown as WtConfigService;

function makeService(auth: Partial<WinthorAuthService>) {
  return new WinthorApiService(configStub, auth as WinthorAuthService);
}

const authOk = () => ({
  getToken: jest.fn().mockResolvedValue('TOKEN'),
  clearToken: jest.fn(),
});

/** Resposta JSON simples. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

describe('WinthorApiService — caminho HTTP', () => {
  it('manda AbortSignal em toda chamada', async () => {
    fetchMock.mockResolvedValue(json({ a: 1 }));
    await makeService(authOk()).getJson('/x');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('timeout vira {ok:false, status:0} em vez de exceção', async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    fetchMock.mockRejectedValue(err);

    const result = await makeService(authOk()).getJson('/x');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain(String(REQUEST_TIMEOUT_MS));
    expect(result.error).toContain('timeout');
  });

  it('falha de login não escapa como exceção — era o bug do getToken fora do try', async () => {
    const auth = {
      getToken: jest
        .fn()
        .mockRejectedValue(new Error('Login WTA falhou (401)')),
      clearToken: jest.fn(),
    };

    await expect(makeService(auth).getJson('/x')).resolves.toMatchObject({
      ok: false,
      status: 0,
      error: 'Login WTA falhou (401)',
    });
    await expect(makeService(auth).postJson('/x', {})).resolves.toMatchObject({
      ok: false,
      status: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('página de erro HTML nunca vira sucesso, mesmo com status 200', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html><body>Jetty stack trace</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html;charset=utf-8' },
      }),
    );

    const result = await makeService(authOk()).postJson('/x', {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTML');
    expect(result.raw).toContain('Jetty');
  });

  it('401 dispara exatamente um relogin e uma repetição', async () => {
    const auth = authOk();
    fetchMock
      .mockResolvedValueOnce(json({ erro: 'expirado' }, 401))
      .mockResolvedValueOnce(json({ a: 1 }));

    const result = await makeService(auth).getJson('/x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.clearToken).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ a: 1 });
  });

  it('401 persistente não entra em loop', async () => {
    const auth = authOk();
    fetchMock.mockResolvedValue(json({ erro: 'expirado' }, 401));

    const result = await makeService(auth).getJson('/x');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('5xx e timeout nunca são repetidos', async () => {
    const auth = authOk();
    fetchMock.mockResolvedValue(json({ erro: 'boom' }, 500));

    await makeService(auth).getJson('/x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).not.toHaveBeenCalled();
  });

  it('corpo vazio devolve data null sem quebrar', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await makeService(authOk()).getJson('/x');

    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });
});

describe('WinthorApiService — cache das listas completas', () => {
  const clientes = [{ CODIGO: 1 }, { CODIGO: 2 }, { CODIGO: 3 }];

  /** Qual query string cada chamada de fetch levou. */
  const urls = () => fetchMock.mock.calls.map(([url]) => String(url as string));

  it('a segunda página não re-varre a base', async () => {
    // O endpoint não pagina no upstream: sem cache, cada página baixaria a
    // base inteira de novo — a lentidão que a paginação deveria resolver.
    fetchMock.mockResolvedValue(json(clientes));
    const svc = makeService(authOk());

    const p1 = await svc.buscarClientes({ page: 1, pageSize: 2 });
    const p2 = await svc.buscarClientes({ page: 2, pageSize: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p1.data?.items).toHaveLength(2);
    expect(p2.data?.items).toHaveLength(1);
    expect(p1.data?.total).toBe(3);
    expect(p2.data?.cachedAt).toEqual(expect.any(String));
  });

  it('filtros diferentes não compartilham entrada', async () => {
    fetchMock.mockResolvedValue(json(clientes));
    const svc = makeService(authOk());

    await svc.buscarClientes({ nome: 'ABC' });
    await svc.buscarClientes({ nome: 'XYZ' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('nome vazio e nome omitido compartilham entrada', async () => {
    // `getJson` descarta params '' e undefined, então as duas chamadas batem
    // na mesma URL upstream — separá-las no cache seria varredura duplicada.
    fetchMock.mockResolvedValue(json(clientes));
    const svc = makeService(authOk());

    await svc.buscarClientes({ nome: '' });
    await svc.buscarClientes({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falha não é cacheada', async () => {
    fetchMock.mockResolvedValue(json({ erro: 'x' }, 500));
    const svc = makeService(authOk());

    const primeira = await svc.buscarClientes({});
    const segunda = await svc.buscarClientes({});

    expect(primeira.ok).toBe(false);
    expect(segunda.ok).toBe(false);
    expect(primeira.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refresh ignora o cache', async () => {
    fetchMock.mockResolvedValue(json(clientes));
    const svc = makeService(authOk());

    await svc.buscarClientes({});
    await svc.buscarClientes({ refresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('page/pageSize/refresh não vazam para a query do upstream', async () => {
    // O endpoint só aceita `codigo` e `nome` (openapi.json).
    fetchMock.mockResolvedValue(json(clientes));

    await makeService(authOk()).buscarClientes({
      nome: 'ABC',
      page: 2,
      pageSize: 50,
      refresh: false,
    });

    const url = urls()[0];
    expect(url).toContain('nome=ABC');
    expect(url).not.toContain('page');
    expect(url).not.toContain('refresh');
  });

  it('buscarEstoquePorFilial manda codigoFilial e paginação ao upstream', async () => {
    fetchMock.mockResolvedValue(
      json({ items: [{ produtoId: '10', saldo: 5 }] }),
    );

    await makeService(authOk()).buscarEstoquePorFilial({
      codigoFilial: '3',
      produtoId: '10',
      page: 2,
      pageSize: 25,
    });

    const url = urls()[0];
    expect(url).toContain('/wms/api/v1/produto/buscar-produtos');
    expect(url).toContain('codigoFilial=3');
    expect(url).toContain('produtoId=10');
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=25');
    expect(url).toContain('ordering=DESCRICAO');
  });

  it('listarTodasFiliais devolve cópia, não a referência cacheada', async () => {
    fetchMock.mockResolvedValue(json([{ CODIGO: '1' }]));
    const svc = makeService(authOk());

    const primeira = await svc.listarTodasFiliais();
    (primeira.data as unknown[]).push({ CODIGO: 'intruso' });
    const segunda = await svc.listarTodasFiliais();

    // Um `.sort()`/`.push()` no chamador não pode corromper as páginas
    // seguintes.
    expect(segunda.data).toHaveLength(1);
  });
});

describe('WinthorApiService — cap de bytes', () => {
  afterEach(() => {
    delete process.env.WTA_MAX_UPSTREAM_BYTES;
    jest.resetModules();
  });

  it('interrompe corpo gigante com falha avisada em vez de bufferizar tudo', async () => {
    // O limite é lido na carga do módulo, então precisa reimportar com o env já
    // ajustado — senão o teste teria de gerar 8 MB de corpo.
    process.env.WTA_MAX_UPSTREAM_BYTES = '1024';
    jest.resetModules();
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./winthor-api.service') as typeof import('./winthor-api.service');

    const grande = JSON.stringify(
      Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(50) })),
    );
    fetchMock.mockResolvedValue(
      new Response(grande, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const svc = new mod.WinthorApiService(
      configStub,
      authOk() as unknown as WinthorAuthService,
    );
    const result = await svc.getJson('/x');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('1024');
    expect(result.error).toContain('interrompida');
    // Nada de JSON meio lido escapando como sucesso.
    expect(result.data).toBeUndefined();
  });
});
