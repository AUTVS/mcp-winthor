/**
 * Cache em memória com TTL, LRU e proteção contra estouro.
 *
 * Existe para as três tools que baixam uma coleção inteira e fatiam localmente
 * (`buscarClientes`, `listarTodasFiliais`, `pesquisarFilial`): sem ele, paginar
 * significaria re-baixar tudo a cada página — exatamente a lentidão que o
 * trabalho de paginação deveria resolver.
 *
 * Ganho de corretude além da latência: com a lista congelada, a página 2 é
 * continuação real da página 1. Sem cache, uma linha inserida no upstream entre
 * as duas desloca todos os offsets seguintes e faz linhas serem puladas.
 *
 * Não é provider injetável de propósito — viraria dependência de DI e mudaria
 * os construtores dos serviços, que os specs instanciam à mão.
 */

export interface TtlCacheOpts {
  ttlMs: number;
  maxEntries: number;
  maxChars: number;
  /** Injetável só para testar expiração sem fake timers. */
  now?: () => number;
}

interface Entrada<T> {
  valor: T;
  chars: number;
  expiraEm: number;
  armazenadoEm: number;
}

export interface ValorCarregado<T> {
  valor: T;
  /** Estimativa de tamanho; precisão é irrelevante para um orçamento. */
  chars: number;
}

export class TtlCache<T> {
  private readonly entradas = new Map<string, Entrada<T>>();
  private readonly emVoo = new Map<string, Promise<T | null>>();
  private readonly now: () => number;
  private chars = 0;

  constructor(private readonly opts: TtlCacheOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  get(chave: string): T | undefined {
    const entrada = this.entradas.get(chave);
    if (!entrada) return undefined;

    if (entrada.expiraEm <= this.now()) {
      this.entradas.delete(chave);
      this.chars -= entrada.chars;
      return undefined;
    }

    // Reinsere para a ordem do Map virar LRU.
    this.entradas.delete(chave);
    this.entradas.set(chave, entrada);
    return entrada.valor;
  }

  set(chave: string, valor: T, chars: number): void {
    const anterior = this.entradas.get(chave);
    if (anterior) this.chars -= anterior.chars;

    const agora = this.now();
    this.entradas.delete(chave);
    this.entradas.set(chave, {
      valor,
      chars,
      expiraEm: agora + this.opts.ttlMs,
      armazenadoEm: agora,
    });
    this.chars += chars;

    // Entradas grandes não são recusadas: a base sem filtro é justamente o
    // caso que o cache existe para cobrir. Elas apenas empurram as outras.
    while (
      this.entradas.size > this.opts.maxEntries ||
      (this.chars > this.opts.maxChars && this.entradas.size > 1)
    ) {
      const maisAntiga = this.entradas.keys().next();
      if (maisAntiga.done) break;
      const removida = this.entradas.get(maisAntiga.value);
      this.entradas.delete(maisAntiga.value);
      if (removida) this.chars -= removida.chars;
    }
  }

  /**
   * Busca no cache ou carrega, coalescendo chamadas concorrentes.
   *
   * Sem a coalescência, "página 1 e página 2 ao mesmo tempo" — que é o cenário
   * alvo, já que clientes MCP disparam tool calls em paralelo — erraria duas
   * vezes e puxaria a base inteira duas vezes.
   *
   * `carregar` devolvendo `null` significa falha: nada entra no cache.
   * Chave vazia desliga o cache (usado quando não há config).
   */
  async getOrLoad(
    chave: string,
    carregar: () => Promise<ValorCarregado<T> | null>,
  ): Promise<T | null> {
    if (!chave) return (await carregar())?.valor ?? null;

    const cacheado = this.get(chave);
    if (cacheado !== undefined) return cacheado;

    const jaEmVoo = this.emVoo.get(chave);
    if (jaEmVoo) return jaEmVoo;

    const promessa = carregar()
      .then((res) => {
        if (res) this.set(chave, res.valor, res.chars);
        return res?.valor ?? null;
      })
      // Roda depois do `then`, então o valor já está no cache quando a entrada
      // em voo some. Rejeições são compartilhadas mas nunca cacheadas.
      .finally(() => this.emVoo.delete(chave));

    this.emVoo.set(chave, promessa);
    return promessa;
  }

  /** Quando a entrada foi guardada, em ISO — para o chamador expor a defasagem. */
  armazenadoEm(chave: string): string | undefined {
    const entrada = this.entradas.get(chave);
    return entrada ? new Date(entrada.armazenadoEm).toISOString() : undefined;
  }

  clear(): void {
    this.entradas.clear();
    this.chars = 0;
  }

  get size(): number {
    return this.entradas.size;
  }
}

/** Estima chars de uma lista sem serializar tudo: O(1) em vez de O(n). */
export function estimarChars(itens: unknown[]): number {
  if (itens.length === 0) return 0;
  const amostra = itens.slice(0, 3);
  const media =
    amostra.reduce<number>(
      (soma, item) => soma + JSON.stringify(item).length,
      0,
    ) / amostra.length;
  return Math.round(media * itens.length);
}
