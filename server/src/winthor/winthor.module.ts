import { Module } from '@nestjs/common';
import { EstoqueModule } from '../estoque/estoque.module';
import { EstoqueIngestaoService } from '../estoque/estoque-ingestao.service';
import { VendasModule } from '../vendas/vendas.module';
import { VendasAncoraService } from '../vendas/vendas-ancora.service';
import { VendasIngestaoService } from '../vendas/vendas-ingestao.service';
import { WinthorAuthService } from './winthor-auth.service';
import { WinthorApiService } from './winthor-api.service';
import { WinthorMobileService } from './winthor-mobile.service';

/**
 * Importa `VendasModule`, nunca o contrário — o sentido da seta é o que mantém o
 * grafo acíclico sem `forwardRef`. `WinthorMobileService` injeta a LEITURA da
 * base local; `VendasIngestaoService`, que precisa dos dois lados, mora aqui.
 */
@Module({
  imports: [VendasModule, EstoqueModule],
  providers: [
    WinthorAuthService,
    WinthorApiService,
    WinthorMobileService,
    VendasIngestaoService,
    VendasAncoraService,
    EstoqueIngestaoService,
  ],
  exports: [
    WinthorAuthService,
    WinthorApiService,
    WinthorMobileService,
    VendasIngestaoService,
    VendasAncoraService,
    EstoqueIngestaoService,
  ],
})
export class WinthorModule {}
