/**
 * Acesso ao SQLite embutido do node (`node:sqlite`).
 *
 * **Por que o módulo embutido e não `better-sqlite3`:** o instalador Windows é
 * cross-buildado em Docker `linux/amd64` com um único `server/node_modules`
 * compartilhado entre os alvos (`Dockerfile`), não existe passo de
 * `electron-rebuild` em lugar nenhum do repo, e o ABI do node do sistema (127)
 * diverge do node do Electron (133). Um `.node` compilado no build entraria no
 * pacote Windows e falharia no `dlopen` — e o `scripts/verify-artifacts.sh` não
 * rejeita `.node`, então o artefato quebrado passaria na validação e só falharia
 * no boot do usuário final. `node:sqlite` é estaticamente ligado nos dois
 * runtimes: nada para compilar, nenhum eixo de ABI, zero mudança no empacotamento.
 *
 * Verificado: funciona sem flag no node do sistema (v22.23.1) e sob o node do
 * Electron 35.7.5 (22.16.0), com superfície de API idêntica, e resolve no jest.
 */

/**
 * Silencia UM aviso: o de que `node:sqlite` é experimental.
 *
 * Ele sairia no stderr a cada start, e o desktop herda o stdio do filho
 * (`desktop/src/server-process.ts`) — o usuário veria um aviso de plataforma que
 * não pode resolver. `NODE_NO_WARNINGS=1` no spawn resolveria, mas apagaria
 * também `DeprecationWarning` real, que se quer ver. Daí o filtro cirúrgico.
 *
 * Verificado no alvo que importa: com este módulo compilado, `node` e o node do
 * Electron 35 carregam `node:sqlite` sem imprimir nada. **Sob o jest o aviso ainda
 * aparece** — o runner mexe na ordem de carga dos módulos — e isso é ruído de
 * console de teste, não comportamento de produção. Não vale complicar o filtro
 * para calar um aviso que o usuário nunca vai ver.
 */
type Emissor = (nome: string, ...args: unknown[]) => boolean;

const emitirOriginal = process.emit.bind(process) as unknown as Emissor;

(process as unknown as { emit: Emissor }).emit = function (nome, ...args) {
  const dado = args[0];
  if (
    nome === 'warning' &&
    dado instanceof Error &&
    dado.name === 'ExperimentalWarning' &&
    dado.message.includes('SQLite')
  ) {
    return false;
  }
  return emitirOriginal(nome, ...args);
};

/**
 * `require` tardio, e não `import` estático: o aviso nasce no primeiro
 * carregamento do módulo, e o `import` seria içado para cima do filtro acima.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const { DatabaseSync } = sqlite;
export type Db = InstanceType<typeof DatabaseSync>;

/**
 * Pragmas da base.
 *
 * `WAL` — o job de ingestão em segundo plano não pode bloquear tool call; com WAL
 * leitor e escritor convivem.
 * `synchronous = NORMAL` — esta base é cache derivável, não fonte da verdade:
 * pagar fsync por commit compraria uma durabilidade que não vale nada aqui, já
 * que o remédio para corrupção é revarrer.
 * `busy_timeout` — rede de segurança; com um só escritor não deveria disparar.
 * `temp_store = MEMORY` — o GROUP BY de ~13 mil linhas não vai ao disco.
 */
export const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
];

export function aplicarPragmas(db: Db): void {
  for (const pragma of PRAGMAS) {
    db.exec(pragma);
  }
}

/** Abre (ou cria) uma base já com os pragmas aplicados. */
export function abrirBanco(caminho: string): Db {
  const db = new DatabaseSync(caminho);
  aplicarPragmas(db);
  return db;
}
