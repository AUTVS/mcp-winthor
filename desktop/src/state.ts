/**
 * Flags de ciclo de vida compartilhadas entre os módulos.
 *
 * Módulo folha de propósito: `windows.ts` e `tray.ts` precisam consultar
 * `isQuitting` sem importar `main.ts`, o que criaria um ciclo.
 */
export const state = {
  /**
   * `true` a partir do momento em que o encerramento foi pedido de verdade.
   * É o que autoriza o handler de `close` da janela a deixar a janela fechar
   * em vez de escondê-la na bandeja.
   */
  isQuitting: false,
  /** `true` enquanto a parada do servidor filho está em andamento. */
  shuttingDown: false,
};
