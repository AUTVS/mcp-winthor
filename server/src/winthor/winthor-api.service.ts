import { Injectable } from '@nestjs/common';
import { WtConfigService } from '../config/wt-config.service';
import {
  clampPage,
  clampPageSize,
  LIST_CACHE_MAX_CHARS,
  LIST_CACHE_MAX_ENTRIES,
  LIST_CACHE_TTL_MS,
  MAX_UPSTREAM_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../config/limits';
import { estimarChars, TtlCache } from './ttl-cache';
import { WinthorAuthService } from './winthor-auth.service';

/** Quanto ler de uma página de erro HTML antes de desistir. */
const HTML_PREVIEW_BYTES = 2048;

export interface WinthorApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  raw?: string;
  error?: string;
  /** Quando a lista veio do cache, em ISO. Ausente = buscado agora. */
  cachedAt?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  cachedAt?: string;
}

@Injectable()
export class WinthorApiService {
  /** Listas completas dos endpoints que não paginam no upstream. */
  private readonly listCache = new TtlCache<unknown[]>({
    ttlMs: LIST_CACHE_TTL_MS,
    maxEntries: LIST_CACHE_MAX_ENTRIES,
    maxChars: LIST_CACHE_MAX_CHARS,
  });

  constructor(
    private readonly configService: WtConfigService,
    private readonly auth: WinthorAuthService,
  ) {}

  /**
   * Lê o corpo em pedaços, parando em `limite` bytes.
   *
   * `res.text()` bufferiza tudo antes de qualquer um perceber o tamanho — é o
   * que deixava uma resposta de vários MB derrubar a chamada por memória e
   * tempo de parse. Aqui o excesso é cortado e sinalizado.
   */
  private async readBody(
    res: Response,
    limite: number,
  ): Promise<{ text: string; truncated: boolean }> {
    if (!res.body) return { text: '', truncated: false };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes > limite) {
        await reader.cancel();
        return { text, truncated: true };
      }
    }

    text += decoder.decode();
    return { text, truncated: false };
  }

  /** Interpreta uma resposta já recebida: HTML, corpo grande, vazio ou JSON. */
  private async parseResponse<T>(res: Response): Promise<WinthorApiResult<T>> {
    // Falhas do gateway voltam como página de erro Jetty (HTML com stack
    // trace), às vezes com status 200. Detectar pelo header evita bufferizar
    // o trace inteiro só para descobrir que não era JSON.
    const contentType = res.headers.get('content-type') ?? '';
    if (/html/i.test(contentType)) {
      const { text } = await this.readBody(res, HTML_PREVIEW_BYTES);
      return {
        ok: false,
        status: res.status,
        raw: text.slice(0, 300),
        error: 'WinThor devolveu uma página de erro HTML em vez de JSON.',
      };
    }

    const { text, truncated } = await this.readBody(res, MAX_UPSTREAM_BYTES);

    if (truncated) {
      return {
        ok: false,
        status: res.status,
        raw: text.slice(0, 300),
        error: `Resposta do WinThor passou de ${MAX_UPSTREAM_BYTES} bytes e foi interrompida. Reduza pageSize ou aplique filtros.`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        raw: text.slice(0, 500),
        error: `WinThor retornou ${res.status}`,
      };
    }

    if (!text) {
      return { ok: true, status: res.status, data: null as T };
    }

    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      const isHtml = /^\s*<(!doctype|html)/i.test(text);
      return {
        ok: false,
        status: res.status,
        raw: text.slice(0, 300),
        error: isHtml
          ? 'WinThor devolveu uma página de erro HTML em vez de JSON.'
          : 'Resposta não é JSON válido.',
      };
    }
  }

  /** Toda falha vira `{ok:false}` — nada escapa como exceção para o handler MCP. */
  private mapFetchError<T>(err: unknown): WinthorApiResult<T> {
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 0,
      error: timedOut
        ? `WinThor não respondeu em ${REQUEST_TIMEOUT_MS}ms (timeout).`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }

  async getJson<T = unknown>(
    path: string,
    query?: Record<string, string | undefined>,
    extraHeaders?: Record<string, string | undefined>,
    retried = false,
  ): Promise<WinthorApiResult<T>> {
    const cfg = this.configService.getConfig();
    if (!cfg) {
      return {
        ok: false,
        status: 0,
        error: 'Servidor ainda não configurado. Abra / para configurar.',
      };
    }

    let url = `${cfg.winthorBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') {
          params.set(key, value);
        }
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    try {
      // Dentro do try: getToken() lança, e uma falha de login precisa virar
      // {ok:false} como qualquer outra, não uma exceção no handler MCP.
      const token = await this.auth.getToken();

      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: token,
      };
      if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) {
          if (value !== undefined && value !== '') {
            headers[key] = value;
          }
        }
      }

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Token expirado: uma tentativa de relogin. Só 401/403 — timeout e 5xx
      // nunca são repetidos.
      if ((res.status === 401 || res.status === 403) && !retried) {
        await res.body?.cancel();
        this.auth.clearToken();
        return this.getJson<T>(path, query, extraHeaders, true);
      }

      return await this.parseResponse<T>(res);
    } catch (err) {
      return this.mapFetchError<T>(err);
    }
  }

  /**
   * POST com corpo JSON — usado pelas rotinas mobile (/winthor/mobile/v2).
   *
   * Envia o token nas duas vias aceitas pelo WinThor: header `Authorization` e
   * cookie `suukie`. As rotinas mobile foram observadas autenticando por cookie
   * de sessão, e mandar ambos cobre os dois filtros sem custo.
   */
  async postJson<T = unknown>(
    path: string,
    body: unknown,
    retried = false,
  ): Promise<WinthorApiResult<T>> {
    const cfg = this.configService.getConfig();
    if (!cfg) {
      return {
        ok: false,
        status: 0,
        error: 'Servidor ainda não configurado. Abra / para configurar.',
      };
    }

    const url = `${cfg.winthorBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    try {
      const token = await this.auth.getToken();

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: token,
          Cookie: `suukie=${token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if ((res.status === 401 || res.status === 403) && !retried) {
        await res.body?.cancel();
        this.auth.clearToken();
        return this.postJson<T>(path, body, true);
      }

      return await this.parseResponse<T>(res);
    } catch (err) {
      return this.mapFetchError<T>(err);
    }
  }

  /**
   * Identidade da configuração — vazia quando não configurado, o que desliga o
   * cache. `configuredAt` muda a cada `saveFromForm`, então reconfigurar
   * invalida por construção, sem wiring nenhum.
   */
  private chaveConfig(): string {
    const cfg = this.configService.getConfig();
    return cfg ? `${cfg.winthorBaseUrl}|${cfg.login}|${cfg.configuredAt}` : '';
  }

  /**
   * Busca uma coleção completa, servindo do cache quando possível.
   *
   * O upstream destes endpoints não pagina, então a lista inteira vem sempre.
   * Cachear é o que torna a paginação local viável sem re-varrer a base a cada
   * página. Falhas nunca entram no cache; sucessos vazios entram (são respostas
   * válidas e custam nada).
   */
  private async listaCacheada(
    tag: string,
    path: string,
    query: Record<string, string | undefined> | undefined,
    refresh: boolean,
  ): Promise<WinthorApiResult<unknown[]>> {
    const base = this.chaveConfig();
    const chave = base ? `${base}|${tag}` : '';
    if (refresh && chave) this.listCache.clear();

    // Array em vez de `let`: evita o estreitamento do TS numa variável só
    // atribuída dentro do callback.
    const falhas: WinthorApiResult<unknown>[] = [];

    const lista = await this.listCache.getOrLoad(chave, async () => {
      const result = await this.getJson<unknown[]>(path, query);
      if (!result.ok) {
        falhas.push(result);
        return null;
      }
      const itens = Array.isArray(result.data) ? result.data : [];
      return { valor: itens, chars: estimarChars(itens) };
    });

    if (lista === null) {
      // Sem entrada em `falhas` quando esta chamada apenas aguardou outra em
      // voo que falhou — daí o texto genérico de reserva.
      const falha = falhas[0];
      return falha
        ? {
            ok: false,
            status: falha.status,
            error: falha.error,
            raw: falha.raw,
          }
        : {
            ok: false,
            status: 0,
            error: 'Falha ao carregar a lista do WinThor.',
          };
    }

    return {
      ok: true,
      status: 200,
      data: lista,
      cachedAt: chave ? this.listCache.armazenadoEm(chave) : undefined,
    };
  }

  async listarTodasFiliais(opts?: {
    refresh?: boolean;
  }): Promise<WinthorApiResult<unknown[]>> {
    const result = await this.listaCacheada(
      'filiais',
      '/winthor/ferramenta/acesso/v1/filial/listar/todas',
      undefined,
      opts?.refresh ?? false,
    );
    // Cópia rasa: o valor cacheado é compartilhado, e um `.sort()` no chamador
    // corromperia o cache para todas as páginas seguintes.
    return result.ok ? { ...result, data: [...(result.data ?? [])] } : result;
  }

  async buscarClientes(filtro?: {
    codigo?: string;
    nome?: string;
    page?: number;
    pageSize?: number;
    refresh?: boolean;
  }): Promise<WinthorApiResult<PaginatedResult<unknown>>> {
    const { page, pageSize, refresh, ...apiFiltro } = filtro ?? {};
    const safePage = clampPage(page);
    const safePageSize = clampPageSize(pageSize);

    // `getJson` descarta params undefined E '' (mesma URL upstream), então
    // `{nome:''}` e `{}` têm de compartilhar entrada. Não normalizar caixa nem
    // espaços: a semântica de match do upstream é indocumentada e dobrar
    // poderia fundir dois conjuntos distintos.
    const tag = `clientes|codigo=${apiFiltro.codigo ?? ''}&nome=${apiFiltro.nome ?? ''}`;

    const result = await this.listaCacheada(
      tag,
      '/winthor/vendas/faturamento/v0/cliente',
      apiFiltro,
      refresh ?? false,
    );

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      };
    }

    const all = result.data ?? [];
    const total = all.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / safePageSize);
    const start = (safePage - 1) * safePageSize;
    const items = all.slice(start, start + safePageSize);

    return {
      ok: true,
      status: result.status,
      data: {
        items,
        page: safePage,
        pageSize: safePageSize,
        total,
        totalPages,
        cachedAt: result.cachedAt,
      },
    };
  }

  limparCache(): void {
    this.listCache.clear();
  }

  async buscarPedidosVendaFaturados(opts?: {
    page?: number;
    pageSize?: number;
    tenantId?: string;
  }): Promise<WinthorApiResult> {
    const page = clampPage(opts?.page);
    const pageSize = clampPageSize(opts?.pageSize);

    return this.getJson(
      '/wms/api/v2/pedidosVenda/buscarFaturados',
      {
        page: String(page),
        pageSize: String(pageSize),
      },
      opts?.tenantId ? { tenantId: opts.tenantId } : undefined,
    );
  }

  async buscarPedidos(filtro?: {
    page?: number;
    pageSize?: number;
    dataUltimaAlteracao?: string;
    status?: string;
  }): Promise<WinthorApiResult> {
    const page = clampPage(filtro?.page);
    const pageSize = clampPageSize(filtro?.pageSize);

    const query: Record<string, string> = {
      page: String(page),
      pageSize: String(pageSize),
      status: filtro?.status ?? 'ATIVO',
    };

    if (filtro?.dataUltimaAlteracao) {
      query.dataUltimaAlteracao = filtro.dataUltimaAlteracao;
    }

    return this.getJson('/logistica/apis/v1/pedido/buscar', query);
  }

  async buscarEstoquePorFilial(filtro: {
    codigoFilial: string;
    produtoId?: string;
    descricao?: string;
    page?: number;
    pageSize?: number;
  }): Promise<WinthorApiResult> {
    const page = clampPage(filtro.page);
    const pageSize = clampPageSize(filtro.pageSize);

    const query: Record<string, string> = {
      codigoFilial: filtro.codigoFilial,
      page: String(page),
      pageSize: String(pageSize),
      ordering: 'DESCRICAO',
    };

    if (filtro.produtoId) {
      query.produtoId = filtro.produtoId;
    }
    if (filtro.descricao) {
      query.descricao = filtro.descricao;
    }

    return this.getJson('/wms/api/v1/produto/buscar-produtos', query);
  }
}
