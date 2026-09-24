import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WtConfigModule } from './config/config.module';
import { SetupModule } from './setup/setup.module';
import { WinthorModule } from './winthor/winthor.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    WtConfigModule,
    WinthorModule,
    SetupModule,
    McpModule,
  ],
})
export class AppModule {}
