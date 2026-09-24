import { Global, Module } from '@nestjs/common';
import { WtConfigService } from './wt-config.service';

@Global()
@Module({
  providers: [WtConfigService],
  exports: [WtConfigService],
})
export class WtConfigModule {}
