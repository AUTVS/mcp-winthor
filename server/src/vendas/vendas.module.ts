import { Module } from '@nestjs/common';
import { WtConfigModule } from '../config/config.module';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasQueryService } from './vendas-query.service';
import { VendasStoreService } from './vendas-store.service';

/**
 * Base local de vendas.
 *
 * **Não importa `WinthorModule` de propósito.** A leitura (consulta agregada) é
 * injetada em `WinthorMobileService`; se este módulo também dependesse do winthor,
 * o grafo do Nest fecharia um ciclo e exigiria `forwardRef`. A ingestão e a
 * âncora, que precisam dos dois lados, moram em `WinthorModule`.
 */
@Module({
  imports: [WtConfigModule],
  providers: [
    VendasMetaDbService,
    VendasFatoDbService,
    VendasStoreService,
    VendasQueryService,
  ],
  exports: [
    VendasMetaDbService,
    VendasFatoDbService,
    VendasStoreService,
    VendasQueryService,
  ],
})
export class VendasModule {}
