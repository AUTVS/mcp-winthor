import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { appIconPath } from './icons';
import { APP_URL } from './server-process';
import { state } from './state';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

export function hasMainWindow(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed();
}

/** Janela sem moldura exibida enquanto o servidor NestJS sobe. */
export function createSplash(): void {
  if (splashWindow) {
    return;
  }

  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    center: true,
    show: false,
    backgroundColor: '#12161f',
    title: 'wt.ai',
    icon: appIconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  void splashWindow.loadFile(join(__dirname, 'renderer', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

export function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
}

export function createMainWindow(): void {
  if (hasMainWindow()) {
    return;
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'wt.ai',
    icon: appIconPath(),
    // Só exibimos em `ready-to-show`, para não piscar branco antes do render.
    show: false,
    backgroundColor: '#12161f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  void mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    if (!state.isQuitting) {
      showWindow();
    }
  });

  /**
   * Fechar não encerra: o wt.ai é um servidor MCP que precisa continuar no ar.
   * Vale para as três plataformas — a bandeja é o caminho de volta.
   */
  mainWindow.on('close', (event) => {
    if (!state.isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });

  /**
   * `minimize` é emitido depois do fato e não traz evento cancelável, então
   * escondemos em seguida. `showWindow` desfaz o `restore()` na volta.
   */
  mainWindow.on('minimize', () => {
    if (!state.isQuitting) {
      hideToTray();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Ponto único de exibição — recria a janela se ela já tiver sido destruída. */
export function showWindow(): void {
  if (!hasMainWindow()) {
    createMainWindow();
    return;
  }

  const janela = mainWindow as BrowserWindow;
  if (janela.isMinimized()) {
    janela.restore();
  }
  janela.show();
  janela.focus();

  if (process.platform === 'darwin') {
    void app.dock?.show();
  }
}

/** Esconde a janela e, no macOS, tira o app do Dock — fica só na bandeja. */
export function hideToTray(): void {
  if (hasMainWindow()) {
    mainWindow?.hide();
  }

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
}

export function toggleWindow(): void {
  if (hasMainWindow() && mainWindow?.isVisible() && !mainWindow.isMinimized()) {
    hideToTray();
  } else {
    showWindow();
  }
}
