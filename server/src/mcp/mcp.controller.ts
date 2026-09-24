import { All, Controller, Next, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { WtConfigService } from '../config/wt-config.service';
import { EstoqueIngestaoService } from '../estoque/estoque-ingestao.service';
import { VendasIngestaoService } from '../vendas/vendas-ingestao.service';
import { McpServerFactory } from './mcp-server.factory';

@Controller()
export class McpController {
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    private readonly configService: WtConfigService,
    private readonly mcpServerFactory: McpServerFactory,
    private readonly ingestao: VendasIngestaoService,
    private readonly ingestaoEstoque: EstoqueIngestaoService,
  ) {
    const handler = createMcpHandler(() => this.mcpServerFactory.create());
    this.nodeHandler = toNodeHandler(handler);
  }

  @All('mcp')
  async handle(
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (!this.configService.isConfigured()) {
      return res.status(503).json({
        error: 'not_configured',
        message:
          'wt.ai ainda não está configurado. Abra http://127.0.0.1:8787/ para configurar o WinThor.',
      });
    }

    this.ingestao.marcarOcupado();
    this.ingestaoEstoque.marcarOcupado();
    try {
      await this.nodeHandler(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        next(err);
      }
    }
  }
}
