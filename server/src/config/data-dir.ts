import { join } from 'node:path';

/**
 * Diretório de dados do servidor.
 *
 * Extraído de `WtConfigService`, que resolvia isto inline: a base local de vendas
 * precisa cair exatamente no mesmo lugar que o `config.json`, e duas cópias da
 * mesma expressão são duas chances de divergirem.
 *
 * No app empacotado o desktop passa `WTA_DATA_DIR` apontando para o `userData` do
 * Electron (`desktop/src/server-process.ts`) — escrever ao lado do `dist/` falharia,
 * porque no macOS o bundle é somente leitura.
 */
export function dataDir(): string {
  return process.env.WTA_DATA_DIR ?? join(process.cwd(), 'data');
}
