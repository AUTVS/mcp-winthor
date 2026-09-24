import { app, dialog } from 'electron';
import { startedHidden } from './auto-launch';
import {
  HOST,
  PORT,
  isServerRunning,
  killServerSync,
  onServerCrash,
  startServer,
  stopServer,
} from './server-process';
import { state } from './state';
import { createTray, destroyTray, setTrayStatus } from './tray';
import {
  closeSplash,
  createMainWindow,
  createSplash,
  showWindow,
} from './windows';

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // `focus()` sozinho não resolve quando a janela está escondida na bandeja.
    showWindow();
  });

  app.whenReady().then(boot, falhaNoBoot);

  /**
   * Sem no-op aqui o app encerraria ao esconder a janela no Windows e Linux,
   * o que tornaria a bandeja inútil. Quem encerra é o `before-quit`.
   */
  app.on('window-all-closed', () => undefined);

  app.on('activate', () => showWindow());

  app.on('before-quit', (event) => {
    // Primeira instrução, sempre: é o que autoriza a janela a fechar de fato
    // em vez de se esconder, e portanto o que faz o Cmd+Q funcionar.
    state.isQuitting = true;

    if (state.shuttingDown || !isServerRunning()) {
      return;
    }

    // Adia o encerramento até o filho morrer, senão o servidor fica órfão
    // segurando a porta.
    event.preventDefault();
    state.shuttingDown = true;
    void stopServer().finally(() => app.quit());
  });

  app.on('will-quit', () => destroyTray());

  process.on('exit', () => killServerSync());
}

async function boot(): Promise<void> {
  const escondido = startedHidden();

  try {
    // Bandeja primeiro: o usuário vê o app existir no instante zero, mesmo que
    // o servidor leve dezenas de segundos para responder.
    createTray();

    if (!escondido) {
      createSplash();
    }

    onServerCrash(quedaDoServidor);
    await startServer();

    setTrayStatus(`servidor em ${HOST}:${PORT}`);
    closeSplash();

    if (!escondido) {
      createMainWindow();
    }
  } catch (err) {
    falhaNoBoot(err);
  }
}

function falhaNoBoot(err: unknown): void {
  // Fecha o splash antes do diálogo: ele é `alwaysOnTop` e cobriria o erro.
  closeSplash();
  const message = err instanceof Error ? err.message : String(err);
  dialog.showErrorBox(
    'wt.ai',
    `Não foi possível iniciar o servidor local.\n\n${message}`,
  );
  state.isQuitting = true;
  app.quit();
}

function quedaDoServidor(motivo: string): void {
  if (state.isQuitting) {
    return;
  }
  closeSplash();
  dialog.showErrorBox('wt.ai', motivo);
  state.isQuitting = true;
  app.quit();
}
