import { app, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Raiz dos recursos de imagem.
 *
 * Empacotado, `build/` é desempacotado do asar (ver `asarUnpack` no
 * electron-builder.yml) porque `nativeImage.createFromPath` lê pelo lado
 * nativo e não enxerga caminhos dentro do arquivo asar.
 */
function buildDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'build')
    : join(__dirname, '..', 'build');
}

function primeiroExistente(candidatos: string[]): string {
  for (const candidato of candidatos) {
    if (existsSync(candidato)) {
      return candidato;
    }
  }
  return candidatos[candidatos.length - 1];
}

/** Ícone da janela principal e do splash. */
export function appIconPath(): string {
  const dir = buildDir();
  return primeiroExistente([
    join(dir, 'icon.png'),
    join(dir, 'icon-512.png'),
    join(dir, 'icon.icns'),
  ]);
}

/**
 * Ícone da bandeja, já redimensionado.
 *
 * Não marcamos como template image: a logo é colorida e o macOS a
 * renderizaria como uma silhueta preta chapada.
 */
export function trayIcon(): NativeImage {
  const dir = buildDir();
  const caminho = primeiroExistente([
    join(dir, 'icon.iconset', 'icon_16x16@2x.png'),
    join(dir, 'icon.iconset', 'icon_16x16.png'),
    join(dir, 'icon.png'),
  ]);

  const imagem = nativeImage.createFromPath(caminho);
  return imagem.isEmpty()
    ? nativeImage.createEmpty()
    : imagem.resize({ width: 16, height: 16 });
}
