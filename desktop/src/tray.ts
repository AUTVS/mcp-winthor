import { app, Menu, Tray } from 'electron';
import { isAutoLaunchEnabled, setAutoLaunch } from './auto-launch';
import { trayIcon } from './icons';
import { state } from './state';
import { showWindow, toggleWindow } from './windows';

let tray: Tray | null = null;
let status = 'iniciando…';

/** Idempotente: `activate` e o boot podem alcançar esta função mais de uma vez. */
export function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(trayIcon());
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
  atualizarMenu();
}

/** Texto exibido no tooltip da bandeja, ex.: "servidor em 127.0.0.1:8787". */
export function setTrayStatus(novoStatus: string): void {
  status = novoStatus;
  atualizarMenu();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

function atualizarMenu(): void {
  if (!tray) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir wt.ai',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o sistema',
      type: 'checkbox',
      checked: isAutoLaunchEnabled(),
      click: (item) => {
        setAutoLaunch(item.checked);
        // Relê do sistema em vez de confiar no clique: se a gravação falhar,
        // o menu volta a mostrar o estado real.
        atualizarMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        state.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(`wt.ai — ${status}`);
  tray.setContextMenu(menu);
}
