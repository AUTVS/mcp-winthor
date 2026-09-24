import { Injectable, Logger } from '@nestjs/common';
import { WtConfigService } from '../config/wt-config.service';
import { normalizeBaseUrl } from '../config/config.schema';
import { REQUEST_TIMEOUT_MS, TOKEN_PROBE_TTL_MS } from '../config/limits';
import { ConnectionTestResult, WinthorLoginResponse } from './winthor.types';

@Injectable()
export class WinthorAuthService {
  private readonly logger = new Logger(WinthorAuthService.name);
  private token: string | null = null;
  private tokenBaseUrl: string | null = null;
  private tokenLogin: string | null = null;
  /** Quando o token foi confirmado válido pela última vez (epoch ms). */
  private tokenValidatedAt = 0;

  constructor(private readonly configService: WtConfigService) {}

  async login(
    baseUrl: string,
    login: string,
    senhaMd5: string,
  ): Promise<{ accessToken: string }> {
    const url = `${normalizeBaseUrl(baseUrl)}/winthor/autenticacao/v1/login`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ login, senha: senhaMd5 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Login WTA falhou (${res.status}): ${text.slice(0, 300) || res.statusText}`,
      );
    }

    let data: WinthorLoginResponse;
    try {
      data = JSON.parse(text) as WinthorLoginResponse;
    } catch {
      throw new Error('Resposta de login inválida (JSON esperado).');
    }

    if (!data.accessToken) {
      throw new Error('Resposta de login sem accessToken.');
    }

    this.token = data.accessToken;
    this.tokenBaseUrl = normalizeBaseUrl(baseUrl);
    this.tokenLogin = login;
    this.tokenValidatedAt = Date.now();
    return { accessToken: data.accessToken };
  }

  async testConnection(opts?: {
    winthorBaseUrl?: string;
    login?: string;
    senha?: string;
    senhaMd5?: string;
  }): Promise<ConnectionTestResult> {
    try {
      let baseUrl: string;
      let login: string;
      let senhaMd5: string;

      if (
        opts?.winthorBaseUrl &&
        opts?.login &&
        (opts.senha || opts.senhaMd5)
      ) {
        baseUrl = normalizeBaseUrl(opts.winthorBaseUrl);
        login = opts.login.trim();
        senhaMd5 = opts.senhaMd5 ?? this.configService.md5Wta(opts.senha!);
      } else {
        const cfg = this.configService.getConfig();
        if (!cfg) {
          return { ok: false, message: 'Servidor ainda não configurado.' };
        }
        baseUrl = cfg.winthorBaseUrl;
        login = cfg.login;
        senhaMd5 = cfg.senhaMd5;
      }

      const { accessToken } = await this.login(baseUrl, login, senhaMd5);
      const logadoUrl = `${baseUrl}/winthor/autenticacao/v1/logado`;
      const check = await fetch(logadoUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: accessToken,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!check.ok) {
        return {
          ok: false,
          statusCode: check.status,
          message: `Login ok, mas /logado retornou ${check.status}.`,
        };
      }

      return {
        ok: true,
        statusCode: check.status,
        message: `Conectado a ${baseUrl} como ${login}.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`testConnection: ${message}`);
      return { ok: false, message };
    }
  }

  async getToken(): Promise<string> {
    const cfg = this.configService.getConfig();
    if (!cfg) {
      throw new Error(
        'Servidor ainda não configurado. Abra / para configurar.',
      );
    }

    const sameSession =
      this.token &&
      this.tokenBaseUrl === cfg.winthorBaseUrl &&
      this.tokenLogin === cfg.login;

    if (sameSession && this.token) {
      // Dentro da janela o token é reusado direto. Confirmar em /logado a cada
      // chamada dobrava os round-trips de toda tool; se o token tiver expirado
      // aqui dentro, o 401 no WinthorApiService faz o relogin e repete uma vez.
      if (Date.now() - this.tokenValidatedAt < TOKEN_PROBE_TTL_MS) {
        return this.token;
      }

      const ok = await this.isLoggedIn(cfg.winthorBaseUrl, this.token);
      if (ok) {
        this.tokenValidatedAt = Date.now();
        return this.token;
      }
    }

    const { accessToken } = await this.login(
      cfg.winthorBaseUrl,
      cfg.login,
      cfg.senhaMd5,
    );
    return accessToken;
  }

  clearToken(): void {
    this.token = null;
    this.tokenBaseUrl = null;
    this.tokenLogin = null;
    this.tokenValidatedAt = 0;
  }

  private async isLoggedIn(baseUrl: string, token: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${normalizeBaseUrl(baseUrl)}/winthor/autenticacao/v1/logado`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: token,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
