/**
 * `tsc` só emite JavaScript — o HTML e as imagens do splash precisam ser
 * copiados à mão para `dist/`. Usa apenas `node:fs` para não adicionar
 * dependência e funcionar igual no macOS, Windows e Linux.
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const origem = join(raiz, 'src', 'renderer');
const destino = join(raiz, 'dist', 'renderer');

if (!existsSync(origem)) {
  console.error(`copy-assets: ${origem} não existe.`);
  process.exit(1);
}

cpSync(origem, destino, { recursive: true });
console.log(`copy-assets: ${origem} -> ${destino}`);
