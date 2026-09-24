/* eslint-disable no-console */
/**
 * Sonda de semântica de paginação do WinThor — PORTÃO da paginação garantida.
 *
 * O contrato (docs/api-winthor-mobile-rotinas-120-106.md) nunca capturou
 * página 2 nem `countDataPage` diferente de 10: os seis paginadores do doc
 * (:49, :87, :271, :349, :454, :501) são todos `nextPage: "1"`. E o campo se
 * chama **nextPage**, não `page` — se o servidor calcular
 * `offset = nextPage × countDataPage`, mandar "1" devolve as linhas 11-20 e o
 * app estaria descartando em silêncio as 10 primeiras de toda consulta.
 *
 * Esta sonda responde empiricamente o que o doc afirma sem evidência.
 *
 * Estritamente leitura: só chama endpoints `listar*`/`pesquisar*`, por
 * allowlist de chaves de ENDPOINTS. Não imprime credencial, token nem
 * conteúdo de linha — só impressões digitais, contagens e tamanhos.
 *
 *   npm run probe:pagination -- --all
 *   npm run probe:pagination -- --endpoint pedidosDeVenda --json
 */
import { createHash } from 'node:crypto';
import { WtConfigService } from '../src/config/wt-config.service';
import { WinthorAuthService } from '../src/winthor/winthor-auth.service';
import { WinthorApiService } from '../src/winthor/winthor-api.service';
import {
  ColunaGrid,
  ENDPOINTS,
  MOBILE_BASE,
  PERIODOS,
} from '../src/winthor/winthor-mobile.types';
import { COLUNAS } from '../src/mcp/tools/mobile-tools';

type ChaveEndpoint = keyof typeof ENDPOINTS;

/** Fora de escopo: envelope reduzido sem paginador (§6.3) e DATA_MODEL. */
const SEM_PAGINADOR: ChaveEndpoint[] = [
  'usuarioLogado',
  'pesquisarFilial',
  'valorCarteira',
];

const W120: ChaveEndpoint[] = [
  'inadimplenciaPorFilial',
  'inadimplenciaPorCliente',
  'inadimplenciaPorSupervisor',
  'inadimplenciaPorRamoAtividade',
  'inadimplenciaPorCobranca',
  'inadimplenciaPorDiaAtraso',
  'inadimplenciaPorValor',
];
const LOOKUPS: ChaveEndpoint[] = [
  'inadimplenciaPesquisarSupervisor',
  'inadimplenciaPesquisarCliente',
  'inadimplenciaPesquisarTipoCobranca',
  'lucratividadePesquisarCliente',
  'lucratividadePesquisarEmitente',
  'lucratividadePesquisarSupervisor',
  'lucratividadePesquisarRca',
];
const W106: ChaveEndpoint[] = [
  'pedidosDeVenda',
  'lucratividadePorRca',
  'itensPedidoDeVenda',
  'faltasPedidoDeVenda',
];

const PROBEAVEIS = [...W120, ...LOOKUPS, ...W106];

interface Opcoes {
  endpoints: ChaveEndpoint[];
  filial?: string;
  periodo: string;
  delayMs: number;
  json: boolean;
  codigoPedido?: string;
  nomeFilial?: string;
}

function parseArgs(argv: string[]): Opcoes {
  const opts: Opcoes = {
    endpoints: [],
    periodo: '3',
    delayMs: 250,
    json: false,
  };
  const escolhidos: ChaveEndpoint[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const proximo = () => argv[++i];
    switch (arg) {
      case '--all':
        escolhidos.push(...PROBEAVEIS);
        break;
      case '--group': {
        const g = proximo();
        const grupo =
          g === 'w120' ? W120 : g === 'w106' ? W106 : g === 'lookups' ? LOOKUPS : null;
        if (!grupo) {
          console.error(`grupo desconhecido: ${g} (use w120|w106|lookups)`);
          process.exit(2);
        }
        escolhidos.push(...grupo);
        break;
      }
      case '--endpoint': {
        const chave = proximo() as ChaveEndpoint;
        if (SEM_PAGINADOR.includes(chave)) {
          console.error(
            `fora de escopo: ${chave} usa envelope reduzido, sem paginador (doc §6.3).`,
          );
          process.exit(2);
        }
        if (!PROBEAVEIS.includes(chave)) {
          console.error(`chave desconhecida: ${chave}`);
          console.error(`disponíveis: ${PROBEAVEIS.join(', ')}`);
          process.exit(2);
        }
        escolhidos.push(chave);
        break;
      }
      case '--filial':
        opts.filial = proximo();
        break;
      case '--periodo':
        opts.periodo = proximo();
        break;
      case '--delay-ms':
        opts.delayMs = Number(proximo()) || 250;
        break;
      case '--codigo-pedido':
        opts.codigoPedido = proximo();
        break;
      case '--nome-filial':
        opts.nomeFilial = proximo();
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        console.error(`argumento desconhecido: ${arg}`);
        process.exit(2);
    }
  }

  opts.endpoints = [...new Set(escolhidos.length ? escolhidos : PROBEAVEIS)];
  return opts;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Impressão digital estável de uma linha: não há PK universal nos 18. */
const fingerprint = (linha: Record<string, unknown>): string =>
  createHash('sha1')
    .update(
      JSON.stringify(
        Object.entries(linha).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex')
    .slice(0, 12);

/**
 * Cópia deliberada de `gridRequest` (winthor-mobile.service.ts). A sonda não
 * chama `grid()` porque `clampPage` força page >= 1, o que impossibilitaria o
 * teste de base zero — que é justamente a pergunta mais importante.
 */
function envelope(
  colunas: readonly ColunaGrid[],
  parameters: Record<string, unknown>,
  nextPage: string,
  countDataPage: string,
) {
  return {
    data: { list: [...colunas] },
    parameters: { parameters },
    // Strings: número devolve HTTP 500 (§6.4).
    paginator: { nextPage, countDataPage, paginator: true },
    dataChart: {},
  };
}

interface Resposta {
  ok: boolean;
  status: number;
  erro?: string;
  linhas: Record<string, unknown>[];
  fps: string[];
  count?: number;
  chars: number;
  ms: number;
}

async function chamar(
  api: WinthorApiService,
  path: string,
  corpo: unknown,
): Promise<Resposta> {
  const inicio = Date.now();
  const r = await api.postJson<{
    data?: { list?: { data?: Record<string, unknown> }[] };
    paginator?: { count?: number };
  }>(`${MOBILE_BASE}/${path}`, corpo);
  const ms = Date.now() - inicio;

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      erro: r.error,
      linhas: [],
      fps: [],
      chars: 0,
      ms,
    };
  }

  const linhas = (r.data?.data?.list ?? []).map((i) => i.data ?? {});
  return {
    ok: true,
    status: r.status,
    linhas,
    fps: linhas.map(fingerprint),
    count: r.data?.paginator?.count,
    chars: JSON.stringify(linhas).length,
    ms,
  };
}

function filtrosW120(filiais: string[], periodo: string) {
  return {
    listaFilial: filiais,
    periodo,
    descricaoPeriodo: PERIODOS[periodo as keyof typeof PERIODOS] ?? 'Mês atual',
    listaCliente: null,
    listaSupervisor: null,
    listaTipoCobranca: null,
  };
}

function filtrosW106(
  filiais: string[],
  periodo: string,
  perspectiva: '1' | '2',
) {
  return {
    listaFilial: filiais,
    listaCliente: null,
    listaEmitente: null,
    listaRca: null,
    listaSupervisor: null,
    margemMinLucro: '100',
    numeroPedido: '',
    numeroPedidoRca: '',
    posicaoPedido: '0',
    periodo,
    descricaoPeriodo: PERIODOS[periodo as keyof typeof PERIODOS] ?? 'Mês atual',
    perspectiva,
  };
}

function colunasDe(chave: ChaveEndpoint): readonly ColunaGrid[] {
  const mapa: Partial<Record<ChaveEndpoint, readonly ColunaGrid[]>> = {
    inadimplenciaPorFilial: COLUNAS.inadimplenciaPorFilial,
    inadimplenciaPorCliente: COLUNAS.inadimplenciaPorCliente,
    pedidosDeVenda: COLUNAS.pedidosDeVenda,
    lucratividadePorRca: COLUNAS.lucratividadePorRca,
    itensPedidoDeVenda: COLUNAS.itensPedido,
    faltasPedidoDeVenda: COLUNAS.faltasPedido,
  };
  return mapa[chave] ?? COLUNAS.codigoNome;
}

function parametrosDe(
  chave: ChaveEndpoint,
  filiais: string[],
  opts: Opcoes,
): Record<string, unknown> {
  if (LOOKUPS.includes(chave)) return { termo: '' };
  if (W120.includes(chave)) return filtrosW120(filiais, opts.periodo);

  const base = filtrosW106(
    filiais,
    opts.periodo,
    chave === 'lucratividadePorRca' ? '2' : '1',
  );
  if (chave === 'itensPedidoDeVenda' || chave === 'faltasPedidoDeVenda') {
    return {
      ...base,
      codigoPedido: opts.codigoPedido ?? '',
      nomeFilial: opts.nomeFilial ?? '',
      NUMERO_PEDIDO: opts.codigoPedido ?? '',
    };
  }
  return base;
}

interface Veredicto {
  endpoint: ChaveEndpoint;
  path: string;
  q1_paginaDois: string;
  q1b_baseIndice: string;
  q2_offset: string;
  q3_ordenacao: string;
  q4_count: string;
  q5_tamanhoGrande: string;
  overflow: string;
  dupWithinPage: number;
  linhas: Record<string, number>;
  charsPorLinha: { media: number; p95: number; max: number };
  msAt200: number;
  recommendedPageSize: number;
  inconclusivo: boolean;
  notas: string[];
}

const MAX_RESULT_CHARS = Number(process.env.WTA_MAX_RESULT_CHARS) || 80_000;
const RESERVA = 2_000;

function estatisticasLinha(linhas: Record<string, unknown>[]) {
  if (!linhas.length) return { media: 0, p95: 0, max: 0 };
  const tamanhos = linhas.map((l) => JSON.stringify(l).length).sort((a, b) => a - b);
  return {
    media: Math.round(tamanhos.reduce((s, n) => s + n, 0) / tamanhos.length),
    p95: tamanhos[Math.min(tamanhos.length - 1, Math.floor(tamanhos.length * 0.95))],
    max: tamanhos[tamanhos.length - 1],
  };
}

async function sondar(
  api: WinthorApiService,
  chave: ChaveEndpoint,
  filiais: string[],
  opts: Opcoes,
): Promise<Veredicto> {
  const path = ENDPOINTS[chave];
  const colunas = colunasDe(chave);
  const params = parametrosDe(chave, filiais, opts);
  const notas: string[] = [];

  const req = (nextPage: string, size: string) =>
    chamar(api, path, envelope(colunas, params, nextPage, size));

  const c1 = await req('1', '10');
  await dormir(opts.delayMs);
  const c2 = await req('1', '10');
  await dormir(opts.delayMs);
  const c3 = await req('2', '10');
  await dormir(opts.delayMs);
  const c4 = await req('1', '20');
  await dormir(opts.delayMs);
  const c5 = await req('0', '10');
  await dormir(opts.delayMs);

  const totalPaginas = c1.count ? Math.ceil(c1.count / 10) : 2;
  const c6 = await req(String(totalPaginas + 1), '10');
  await dormir(opts.delayMs);
  const c7 = await req('1', '200');

  const veredicto: Veredicto = {
    endpoint: chave,
    path,
    q1_paginaDois: 'INCONCLUSIVE',
    q1b_baseIndice: 'INCONCLUSIVE',
    q2_offset: 'INCONCLUSIVE',
    q3_ordenacao: 'INCONCLUSIVE',
    q4_count: 'ABSENT',
    q5_tamanhoGrande: 'INCONCLUSIVE',
    overflow: 'INCONCLUSIVE',
    dupWithinPage: c1.fps.length - new Set(c1.fps).size,
    linhas: { c1: c1.linhas.length, c3: c3.linhas.length, c4: c4.linhas.length, c7: c7.linhas.length },
    charsPorLinha: estatisticasLinha(c7.linhas.length ? c7.linhas : c1.linhas),
    msAt200: c7.ms,
    recommendedPageSize: 10,
    inconclusivo: false,
    notas,
  };

  if (!c1.ok) {
    veredicto.q1_paginaDois = `ERROR(${c1.status})`;
    notas.push(c1.erro ?? 'falha na chamada base');
    veredicto.inconclusivo = true;
    return veredicto;
  }

  // Sem linhas suficientes, "página 2 vazia" não distingue contrato quebrado de
  // mês fraco. Os dois drill-downs normalmente caem aqui — resultado honesto.
  if (c1.linhas.length < 10 && (c1.count ?? 0) <= 20) {
    veredicto.inconclusivo = true;
    notas.push(
      'INCONCLUSIVE_TOO_FEW_ROWS: amplie --periodo/--filial para ter >20 linhas.',
    );
  }

  // Q4 — count presente e consistente?
  if (typeof c1.count === 'number') {
    veredicto.q4_count = `PRESENT(${c1.count})`;
    if (c2.count !== c1.count) veredicto.q4_count = `INCONSISTENT(${c1.count},${String(c2.count)})`;
    else if (c4.count !== undefined && c4.count !== c1.count) {
      veredicto.q4_count = 'VARIES_WITH_PAGE_SIZE';
      notas.push('count muda com countDataPage: não é total, totalPages seria inválido.');
    }
  }

  // Q3 — ordenação estável entre chamadas idênticas.
  if (c2.ok) {
    const mesmaOrdem = c1.fps.join() === c2.fps.join();
    const mesmoConjunto =
      new Set(c1.fps).size === new Set(c2.fps).size &&
      [...new Set(c1.fps)].every((f) => c2.fps.includes(f));
    veredicto.q3_ordenacao = mesmaOrdem
      ? 'STABLE'
      : mesmoConjunto
        ? 'SAME_SET_DIFFERENT_ORDER'
        : 'DIFFERENT_SET';
    if (veredicto.q3_ordenacao === 'SAME_SET_DIFFERENT_ORDER') {
      notas.push('Ordem instável: paginação por offset é inerentemente furada aqui.');
    }
  }

  // Q1 — página 2 traz linhas diferentes?
  if (!c3.ok) veredicto.q1_paginaDois = `ERROR(${c3.status})`;
  else if (!c3.linhas.length) {
    veredicto.q1_paginaDois =
      (c1.count ?? 0) > 10 ? 'EMPTY_DESPITE_COUNT' : 'EMPTY';
  } else {
    const sobrepostos = c3.fps.filter((f) => c1.fps.includes(f)).length;
    veredicto.q1_paginaDois =
      sobrepostos === 0
        ? 'DISTINCT'
        : sobrepostos === c3.fps.length
          ? 'IDENTICAL'
          : `OVERLAP_PARTIAL(${sobrepostos}/${c3.fps.length})`;
  }

  // Q1b — a base do índice. `nextPage` sugere "próxima", não "atual".
  if (c5.ok) {
    if (!c5.linhas.length) veredicto.q1b_baseIndice = 'BASE_1_CONFIRMED';
    else if (c5.fps.join() === c1.fps.join()) veredicto.q1b_baseIndice = 'BASE_1_CONFIRMED';
    else if (c5.fps.every((f) => !c1.fps.includes(f))) {
      veredicto.q1b_baseIndice = 'BASE_0_SUSPECTED';
      notas.push(
        'ALERTA: page "0" devolveu linhas inéditas. Se a base for zero, o app ' +
          'vem descartando as 10 primeiras linhas de toda consulta.',
      );
    } else veredicto.q1b_baseIndice = 'AMBIGUOUS';
  } else {
    veredicto.q1b_baseIndice = `BASE_1_CONFIRMED(erro em page=0: ${c5.status})`;
  }

  // Q2 — offset = (page-1) × countDataPage?
  if (c4.ok && c3.ok) {
    if (c4.linhas.length <= 10 && (c1.count ?? 0) > 20) {
      veredicto.q2_offset = `SIZE_NOT_HONORED(${c4.linhas.length})`;
      notas.push('countDataPage=20 não foi honrado: este endpoint ignora o tamanho.');
    } else {
      const esperado = [...c1.fps, ...c3.fps];
      const divergencia = c4.fps.findIndex((f, i) => f !== esperado[i]);
      veredicto.q2_offset =
        divergencia === -1 && c4.fps.length === esperado.length
          ? 'EXACT'
          : `MISMATCH_AT(${divergencia})`;
    }
  }

  // Q5 — countDataPage grande é honrado, limitado ou recusado?
  if (!c7.ok) veredicto.q5_tamanhoGrande = `REJECTED(${c7.status})`;
  else if (c7.linhas.length === 200) veredicto.q5_tamanhoGrande = 'HONORED(200)';
  else if ((c1.count ?? 0) > c7.linhas.length) {
    veredicto.q5_tamanhoGrande = `CLAMPED_TO(${c7.linhas.length})`;
  } else veredicto.q5_tamanhoGrande = `HONORED(${c7.linhas.length}, esgotou a base)`;

  // Overflow — dá para confiar em "página vazia = acabou"?
  if (!c6.ok) veredicto.overflow = `ERROR(${c6.status})`;
  else if (!c6.linhas.length) veredicto.overflow = 'EMPTY';
  else if (c6.fps.join() === c1.fps.join()) veredicto.overflow = 'REPEATS_FIRST_PAGE';
  else veredicto.overflow = 'REPEATS_LAST_PAGE';

  // Cap recomendado: o menor entre orçamento de bytes, teto honrado e latência.
  const porBytes = veredicto.charsPorLinha.p95
    ? Math.floor((MAX_RESULT_CHARS - RESERVA) / veredicto.charsPorLinha.p95)
    : 200;
  const porTamanho = veredicto.q5_tamanhoGrande.startsWith('CLAMPED_TO')
    ? c7.linhas.length
    : 200;
  veredicto.recommendedPageSize = Math.max(
    10,
    Math.min(200, porBytes, porTamanho),
  );

  return veredicto;
}

function imprimir(v: Veredicto): void {
  const marca = v.inconclusivo ? '· ' : v.q2_offset === 'EXACT' ? '✓ ' : '✗ ';
  console.log(`\n${marca}${v.endpoint}  (${v.path})`);
  console.log(`   página 2 ............ ${v.q1_paginaDois}`);
  console.log(`   base do índice ...... ${v.q1b_baseIndice}`);
  console.log(`   offset .............. ${v.q2_offset}`);
  console.log(`   ordenação ........... ${v.q3_ordenacao}`);
  console.log(`   paginator.count ..... ${v.q4_count}`);
  console.log(`   countDataPage=200 ... ${v.q5_tamanhoGrande}  (${v.msAt200}ms)`);
  console.log(`   além do fim ......... ${v.overflow}`);
  console.log(
    `   chars/linha ......... média ${v.charsPorLinha.media} · p95 ${v.charsPorLinha.p95} · max ${v.charsPorLinha.max}`,
  );
  console.log(`   pageSize recomendado  ${v.recommendedPageSize}`);
  if (v.dupWithinPage) {
    console.log(
      `   nota: ${v.dupWithinPage} linha(s) duplicada(s) DENTRO da página 1 — ` +
        'sobreposição entre páginas pode ser da própria agregação.',
    );
  }
  for (const n of v.notas) console.log(`   ! ${n}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const config = new WtConfigService();
  const cfg = config.getConfig();
  if (!cfg) {
    console.error('Servidor não configurado. Abra a página inicial e configure antes.');
    process.exit(1);
  }
  const api = new WinthorApiService(config, new WinthorAuthService(config));

  // Identidade do run — nunca a senha, nunca o token.
  console.log(`WinThor: ${cfg.winthorBaseUrl}  ·  login: ${cfg.login}`);
  console.log(`Endpoints: ${opts.endpoints.length}  ·  ~${opts.endpoints.length * 7 + 2} chamadas`);
  console.log('Rode fora do horário de pico: são queries agregadas pesadas.\n');

  // Filiais: informadas ou descobertas pelo usuário logado.
  let filiais = opts.filial ? [opts.filial] : [];
  if (!filiais.length) {
    const usuario = await api.postJson<{ data?: { MATRICULA?: unknown } }>(
      `${MOBILE_BASE}/${ENDPOINTS.usuarioLogado}`,
      {},
    );
    const matricula = usuario.data?.data?.MATRICULA;
    if (matricula === undefined) {
      console.error('Não consegui descobrir a matrícula; passe --filial.');
      process.exit(1);
    }
    const resp = await api.postJson<{
      data?: { list?: { data?: { CODIGO?: unknown } }[] };
    }>(`${MOBILE_BASE}/${ENDPOINTS.pesquisarFilial}`, {
      data: { matricula: String(matricula) },
    });
    filiais = (resp.data?.data?.list ?? [])
      .map((f) => f.data?.CODIGO)
      .filter((c): c is string | number => c !== undefined)
      .map(String);
  }
  if (!filiais.length) {
    console.error('Nenhuma filial resolvida; passe --filial.');
    process.exit(1);
  }
  console.log(`Filiais: ${filiais.join(', ')}  ·  período: ${opts.periodo}`);

  const veredictos: Veredicto[] = [];
  for (const chave of opts.endpoints) {
    const v = await sondar(api, chave, filiais, opts);
    veredictos.push(v);
    if (!opts.json) imprimir(v);
    await dormir(opts.delayMs);
  }

  const conclusivos = veredictos.filter((v) => !v.inconclusivo);
  const reprovados = conclusivos.filter(
    (v) =>
      v.q1_paginaDois !== 'DISTINCT' ||
      !v.q1b_baseIndice.startsWith('BASE_1_CONFIRMED') ||
      v.q2_offset !== 'EXACT' ||
      v.q3_ordenacao !== 'STABLE',
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        { veredictos, go: reprovados.length === 0, reprovados: reprovados.map((v) => v.endpoint) },
        null,
        2,
      ),
    );
    return;
  }

  console.log('\n' + '='.repeat(64));
  if (!conclusivos.length) {
    console.log('SEM VEREDICTO — nenhum endpoint teve linhas suficientes.');
  } else if (!reprovados.length) {
    console.log(`GO — ${conclusivos.length} endpoint(s) com paginação por offset coerente.`);
    console.log('Leve os pageSize recomendados para CHARS_POR_LINHA em pagination.ts.');
  } else {
    console.log(`NO-GO — ${reprovados.length} de ${conclusivos.length} endpoint(s) reprovaram:`);
    for (const v of reprovados) {
      console.log(
        `  ${v.endpoint}: pág2=${v.q1_paginaDois} base=${v.q1b_baseIndice} offset=${v.q2_offset} ordem=${v.q3_ordenacao}`,
      );
    }
    console.log('\nEsses precisam de paginação em processo, como pesquisarFilial.');
  }
  const inconclusivos = veredictos.filter((v) => v.inconclusivo);
  if (inconclusivos.length) {
    console.log(`\nInconclusivos (poucas linhas): ${inconclusivos.map((v) => v.endpoint).join(', ')}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
