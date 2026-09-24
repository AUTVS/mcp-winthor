import { Module } from '@nestjs/common';
import { VendasModule } from '../vendas/vendas.module';
import { VendasUiController } from '../vendas/vendas-ui.controller';
import { WinthorModule } from '../winthor/winthor.module';
import { McpClientConfigService } from './mcp-client-config.service';
import { SetupController } from './setup.controller';

/**
 * `VendasUiController` é declarado aqui, e não em `VendasModule`, de propósito.
 *
 * Ele injeta `VendasIngestaoService`, que só `WinthorModule` provê — e `WinthorModule`
 * já importa `VendasModule`. Declarar o controller lá exigiria a seta
 * `VendasModule → WinthorModule` e fecharia o ciclo que os cabeçalhos dos dois módulos
 * existem para evitar (ver `vendas.module.ts` e `winthor.module.ts`). Este módulo é o
 * ponto onde os dois lados já se encontram sem `forwardRef`.
 *
 * O ARQUIVO do controller continua em `src/vendas/`, junto dos colaboradores; só a
 * declaração mora aqui.
 */
@Module({
  imports: [WinthorModule, VendasModule],
  controllers: [SetupController, VendasUiController],
  providers: [McpClientConfigService],
})
export class SetupModule {}
