import {
  Body,
  Controller,
  Get,
  Post,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WtConfigService } from '../config/wt-config.service';
import { WinthorAuthService } from '../winthor/winthor-auth.service';
import {
  McpClientConfigService,
  type McpClientId,
} from './mcp-client-config.service';

@Controller()
export class SetupController {
  constructor(
    private readonly configService: WtConfigService,
    private readonly winthorAuth: WinthorAuthService,
    private readonly mcpClientConfig: McpClientConfigService,
  ) {}

  @Get()
  home(@Res() res: Response) {
    if (this.configService.isConfigured()) {
      return res.render('configured', this.renderConfigured());
    }
    return res.render('setup', {
      layout: 'main',
      title: 'Configurar wt.ai',
      configured: false,
      defaults: {
        // Sem default embutido: o binário distribuído não deve carregar endereço de rede interna.
        winthorBaseUrl: process.env.WTA_BASE ?? '',
        login: '',
      },
      mcpUrl: this.mcpUrl(),
      error: null,
      success: null,
      testResult: null,
    });
  }

  @Post('setup')
  async save(
    @Body()
    body: { winthorBaseUrl?: string; login?: string; senha?: string },
    @Res() res: Response,
  ) {
    const winthorBaseUrl = (body.winthorBaseUrl ?? '').trim();
    const login = (body.login ?? '').trim();
    const senha = body.senha ?? '';

    const viewBase = {
      layout: 'main' as const,
      title: 'Configurar wt.ai',
      configured: false,
      defaults: { winthorBaseUrl, login },
      mcpUrl: this.mcpUrl(),
      success: null as string | null,
      testResult: null as string | null,
    };

    if (!winthorBaseUrl || !login || !senha) {
      return res.status(400).render('setup', {
        ...viewBase,
        error: 'Preencha URL base, login e senha.',
      });
    }

    try {
      const test = await this.winthorAuth.testConnection({
        winthorBaseUrl,
        login,
        senha,
      });
      if (!test.ok) {
        return res.status(400).render('setup', {
          ...viewBase,
          error: `Não foi possível conectar: ${test.message}`,
          testResult: test.message,
        });
      }

      this.configService.saveFromForm({ winthorBaseUrl, login, senha });
      return res.redirect('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).render('setup', {
        ...viewBase,
        error: message,
      });
    }
  }

  @Post('setup/test')
  async test(
    @Body()
    body: { winthorBaseUrl?: string; login?: string; senha?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const winthorBaseUrl = (body.winthorBaseUrl ?? '').trim();
    const login = (body.login ?? '').trim();
    const senha = body.senha ?? '';
    const wantsJson = (req.headers.accept ?? '').includes('application/json');

    if (!winthorBaseUrl || !login || !senha) {
      if (wantsJson) {
        return res
          .status(400)
          .json({ ok: false, message: 'Preencha todos os campos.' });
      }
      return res.status(400).render('setup', {
        layout: 'main',
        title: 'Configurar wt.ai',
        configured: false,
        defaults: { winthorBaseUrl, login },
        mcpUrl: this.mcpUrl(),
        error: 'Preencha URL base, login e senha para testar.',
        success: null,
        testResult: null,
      });
    }

    const result = await this.winthorAuth.testConnection({
      winthorBaseUrl,
      login,
      senha,
    });

    if (wantsJson) {
      return res.status(result.ok ? 200 : 400).json(result);
    }

    return res.render('setup', {
      layout: 'main',
      title: 'Configurar wt.ai',
      configured: false,
      defaults: { winthorBaseUrl, login },
      mcpUrl: this.mcpUrl(),
      error: result.ok ? null : result.message,
      success: result.ok ? result.message : null,
      testResult: result.message,
    });
  }

  @Post('setup/reset')
  @Redirect('/')
  reset() {
    this.configService.clear();
    this.winthorAuth.clearToken();
  }

  @Post('setup/mcp/cursor')
  configureMcpCursor(@Res() res: Response) {
    return this.handleMcpConfigure(res, 'cursor');
  }

  @Post('setup/mcp/claude-desktop')
  configureMcpClaudeDesktop(@Res() res: Response) {
    return this.handleMcpConfigure(res, 'claude-desktop');
  }

  @Post('setup/mcp/claude-code')
  configureMcpClaudeCode(@Res() res: Response) {
    return this.handleMcpConfigure(res, 'claude-code');
  }

  @Post('setup/mcp/chatgpt')
  configureMcpChatgpt(@Res() res: Response) {
    return this.handleMcpConfigure(res, 'chatgpt');
  }

  private handleMcpConfigure(res: Response, client: McpClientId) {
    if (!this.configService.isConfigured()) {
      return res.status(503).json({
        ok: false,
        message:
          'wt.ai ainda não está configurado. Configure o WinThor antes de conectar clientes MCP.',
      });
    }

    const result = this.mcpClientConfig.configure(client, this.mcpUrl());
    return res.status(result.ok ? 200 : 500).json(result);
  }

  private renderConfigured() {
    const cfg = this.configService.getConfig()!;
    const mcpUrl = this.mcpUrl();

    return {
      layout: 'main',
      title: 'wt.ai configurado',
      configured: true,
      config: {
        winthorBaseUrl: cfg.winthorBaseUrl,
        login: cfg.login,
        configuredAt: cfg.configuredAt,
      },
      mcpUrl,
      snippets: {
        cursor: this.mcpClientConfig.getSnippet('cursor', mcpUrl),
        claudeDesktop: this.mcpClientConfig.getSnippet(
          'claude-desktop',
          mcpUrl,
        ),
        claudeCode: this.mcpClientConfig.getSnippet('claude-code', mcpUrl),
        chatgpt: this.mcpClientConfig.getSnippet('chatgpt', mcpUrl),
      },
      error: null,
      success: null,
    };
  }

  private mcpUrl(): string {
    const host = process.env.HOST ?? '127.0.0.1';
    const port = process.env.PORT ?? '8787';
    return `http://${host}:${port}/mcp`;
  }
}
