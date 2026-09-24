import { Module } from '@nestjs/common';
import { WtConfigModule } from '../config/config.module';
import { EstoqueFatoDbService } from './estoque-fato-db.service';
import { EstoqueMetaDbService } from './estoque-meta-db.service';
import { EstoqueQueryService } from './estoque-query.service';
import { EstoqueStoreService } from './estoque-store.service';

/**
 * Base local de estoque — não importa WinthorModule (grafo acíclico).
 * A ingestão mora em WinthorModule.
 */
@Module({
  imports: [WtConfigModule],
  providers: [
    EstoqueMetaDbService,
    EstoqueFatoDbService,
    EstoqueStoreService,
    EstoqueQueryService,
  ],
  exports: [
    EstoqueMetaDbService,
    EstoqueFatoDbService,
    EstoqueStoreService,
    EstoqueQueryService,
  ],
})
export class EstoqueModule {}
