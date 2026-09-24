import { app } from 'electron';

/**
 * Argumento passado ao app quando ele é aberto pelo sistema no login.
 * Nesse caso a janela não é criada — sobe direto na bandeja.
 */
export const HIDDEN_FLAG = '--hidden';

/**
 * A fonte de verdade é o próprio sistema operacional, então não há preferência
 * a persistir em disco.
 */
export function isAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: [HIDDEN_FLAG],
  });
}

/** `true` quando o app foi aberto pelo item de login, e não pelo usuário. */
export function startedHidden(): boolean {
  if (process.argv.includes(HIDDEN_FLAG)) {
    return true;
  }
  return app.getLoginItemSettings().wasOpenedAtLogin === true;
}
