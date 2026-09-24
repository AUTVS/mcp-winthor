/**
 * Roda ANTES de qualquer módulo da aplicação ser importado (`setupFiles` do Jest).
 *
 * `INGESTAO_AUTO` é uma `const` avaliada no import de `config/limits.ts`, então
 * definir a variável dentro de `beforeAll` chegaria tarde: a constante já valeria
 * `true`. E `dataDir()` cai em `process.cwd()/data` quando `WTA_DATA_DIR` não está
 * definida — o diretório real do desenvolvedor.
 *
 * Sem este arquivo, `npm run test:e2e` escreve na base local de vendas de verdade
 * e dispara uma varredura contra o ERP de produção configurado na máquina.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WTA_DATA_DIR = mkdtempSync(join(tmpdir(), 'wtai-e2e-'));
process.env.WTA_INGESTAO_AUTO = '0';
process.env.WTA_ESTOQUE_INGESTAO_AUTO = '0';
