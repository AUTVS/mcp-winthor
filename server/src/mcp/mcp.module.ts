import { Module } from '@nestjs/common';
import { EstoqueModule } from '../estoque/estoque.module';
import { VendasModule } from '../vendas/vendas.module';
import { WinthorModule } from '../winthor/winthor.module';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';

@Module({
  // Módulos de base local explícitos — a factory injeta meta/fato/store direto.
  imports: [WinthorModule, VendasModule, EstoqueModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
