import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 8787);
export const APP_URL = `http://${HOST}:${PORT}`;

/** Tempo máximo esperando o servidor responder no boot. */
const BOOT_TIMEOUT_MS = 30_000;
/** Espera pelo SIGTERM antes de escalar para SIGKILL. */
const SIGTERM_TIMEOUT_MS = 5_000;
/** Espera pelo SIGKILL antes de desistir. */
const SIGKILL_TIMEOUT_MS = 2_000;

let serverProcess: ChildProcess | null = null;
let saiu = false;
/** `true` enquanto a parada é intencional — suprime o alerta de queda. */
let parandoDeProposito = false;
let aoCair: ((motivo: string) => void) | null = null;

/**
 * Registra o que fazer quando o servidor morrer sozinho, fora de um
 * encerramento pedido pelo usuário.
 */
export function onServerCrash(callback: (motivo: string) => void): void {
  aoCair = callback;
}

export function isServerRunning(): boolean {
  return serverProcess !== null && !saiu;
}

function resolveServerPaths(): { serverDir: string; serverMain: string } {
  const serverDir = app.isPackaged
    ? join(process.resourcesPath, 'server')
    : join(__dirname, '..', '..', 'server');
  const serverMain = join(serverDir, 'dist', 'main.js');

  if (!existsSync(serverMain)) {
    throw new Error(
      `Servidor não encontrado em ${serverMain}. Execute "npm run build:server" antes.`,
    );
  }

  return { serverDir, serverMain };
}

export async function startServer(): Promise<void> {
  if (isServerRunning()) {
    return;
  }

  const { serverDir, serverMain } = resolveServerPaths();

  /**
   * Checagem antes do spawn, não depois: se algo já responde na porta, o
   * `waitForServer` abaixo aceitaria esse estranho como se fosse o nosso
   * servidor — e a corrida com o EADDRINUSE do filho decidiria quem vence.
   */
  if (await portaOcupada()) {
    throw new Error(
      `A porta ${PORT} já está em uso em ${HOST}. Feche o outro processo (ou uma instância anterior do wt.ai) e tente de novo.`,
    );
  }

  saiu = false;
  parandoDeProposito = false;
  const filho = spawn(process.execPath, [serverMain], {
    cwd: serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WTA_DATA_DIR: app.getPath('userData'),
      HOST,
      PORT: String(PORT),
    },
    stdio: 'inherit',
  });
  serverProcess = filho;

  /**
   * Se o filho morrer durante o boot (EADDRINUSE é o caso comum), rejeitamos
   * na hora em vez de deixar o `waitForServer` consumir os 30s inteiros — a
   * mensagem de erro fica útil.
   */
  const morteDuranteBoot = new Promise<never>((_, reject) => {
    filho.once('exit', (code, signal) => {
      reject(
        new Error(
          `O servidor encerrou durante a inicialização (código ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}).`,
        ),
      );
    });
    filho.once('error', (err) => {
      reject(new Error(`Falha ao iniciar o servidor: ${err.message}`));
    });
  });
  // O race abaixo já trata a rejeição; sem isto o Node reporta unhandled.
  morteDuranteBoot.catch(() => undefined);

  filho.on('exit', () => {
    saiu = true;
  });

  try {
    await Promise.race([waitForServer(APP_URL, BOOT_TIMEOUT_MS), morteDuranteBoot]);
  } catch (err) {
    filho.removeAllListeners('exit');
    filho.removeAllListeners('error');
    if (!filho.killed) {
      filho.kill('SIGKILL');
    }
    serverProcess = null;
    saiu = true;
    throw err;
  }

  // Boot concluído: a partir daqui uma saída é anômala.
  filho.removeAllListeners('exit');
  filho.removeAllListeners('error');
  filho.on('error', (err) => {
    if (!parandoDeProposito) {
      aoCair?.(err.message);
    }
  });
  filho.on('exit', (code, signal) => {
    saiu = true;
    if (parandoDeProposito) {
      return;
    }
    aoCair?.(
      `O servidor encerrou inesperadamente (código ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}).`,
    );
  });
}

/**
 * Encerramento gracioso: SIGTERM, e só escala para SIGKILL se o filho não sair.
 * A referência só é liberada depois que o processo realmente morreu — do
 * contrário, um filho que ignora o SIGTERM fica órfão segurando a porta.
 */
export async function stopServer(): Promise<void> {
  const filho = serverProcess;
  parandoDeProposito = true;
  if (!filho || saiu) {
    serverProcess = null;
    return;
  }

  filho.kill('SIGTERM');
  if (await esperarSaida(filho, SIGTERM_TIMEOUT_MS)) {
    serverProcess = null;
    return;
  }

  filho.kill('SIGKILL');
  await esperarSaida(filho, SIGKILL_TIMEOUT_MS);
  serverProcess = null;
}

/**
 * Última linha de defesa, chamada de `process.on('exit')` — onde nada
 * assíncrono roda.
 */
export function killServerSync(): void {
  parandoDeProposito = true;
  if (serverProcess && !saiu) {
    try {
      serverProcess.kill('SIGKILL');
    } catch {
      // O processo já pode ter morrido; nada a fazer no caminho de saída.
    }
  }
}

/** Tenta abrir a porta para saber se está livre; não conecta em ninguém. */
function portaOcupada(): Promise<boolean> {
  return new Promise((resolve) => {
    const sonda = createServer();
    sonda.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE');
    });
    sonda.once('listening', () => {
      sonda.close(() => resolve(false));
    });
    sonda.listen(PORT, HOST);
  });
}

function esperarSaida(filho: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (filho.exitCode !== null || filho.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      filho.off('exit', aoSair);
      resolve(false);
    }, timeoutMs);

    function aoSair(): void {
      clearTimeout(timer);
      resolve(true);
    }

    filho.once('exit', aoSair);
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 400) {
        return;
      }
    } catch {
      // Servidor ainda subindo.
    }
    await sleep(300);
  }

  throw new Error(`Timeout aguardando o servidor em ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
