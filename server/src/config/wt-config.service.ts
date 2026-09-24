import { Injectable, Logger } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from './data-dir';
import { normalizeBaseUrl, SetupFormInput, WtConfig } from './config.schema';

@Injectable()
export class WtConfigService {
  private readonly logger = new Logger(WtConfigService.name);
  private readonly configPath: string;
  private cache: WtConfig | null | undefined;

  constructor() {
    this.configPath = join(dataDir(), 'config.json');
  }

  isConfigured(): boolean {
    return this.getConfig() !== null;
  }

  getConfig(): WtConfig | null {
    if (this.cache !== undefined) {
      return this.cache;
    }
    if (!existsSync(this.configPath)) {
      this.cache = null;
      return null;
    }
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as WtConfig;
      if (
        !parsed.winthorBaseUrl ||
        !parsed.login ||
        !parsed.senhaMd5 ||
        !parsed.configuredAt
      ) {
        this.cache = null;
        return null;
      }
      this.cache = parsed;
      return parsed;
    } catch (err) {
      this.logger.warn(`Falha ao ler config.json: ${String(err)}`);
      this.cache = null;
      return null;
    }
  }

  saveFromForm(input: SetupFormInput): WtConfig {
    const config: WtConfig = {
      winthorBaseUrl: normalizeBaseUrl(input.winthorBaseUrl),
      login: input.login.trim(),
      senhaMd5: this.md5Wta(input.senha),
      configuredAt: new Date().toISOString(),
    };
    this.writeConfig(config);
    return config;
  }

  /**
   * Apaga a configuração salva. Único caminho que remove `config.json`.
   *
   * O log não é ruído: quando o usuário relata "o login não fica salvo", a primeira
   * pergunta é se alguém chamou isto ou se o arquivo sumiu por fora (data dir
   * diferente, limpeza de disco, teste sem isolamento). Sem o registro, as duas
   * hipóteses são indistinguíveis depois do fato.
   */
  clear(): void {
    const existia = existsSync(this.configPath);
    if (existia) {
      unlinkSync(this.configPath);
    }
    this.cache = null;
    this.logger.warn(
      existia
        ? `configuração apagada a pedido (${this.configPath}).`
        : 'reset pedido, mas não havia configuração salva.',
    );
  }

  md5Wta(plain: string): string {
    return createHash('md5')
      .update(plain.toUpperCase(), 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  private writeConfig(config: WtConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.cache = config;
  }
}
