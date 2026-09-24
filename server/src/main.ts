import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const viewsPath = join(__dirname, '..', 'views');
  const publicPath = join(__dirname, '..', 'public');

  app.useStaticAssets(publicPath);
  app.setBaseViewsDir(viewsPath);
  app.engine(
    'hbs',
    engine({
      extname: '.hbs',
      defaultLayout: 'main',
      layoutsDir: join(viewsPath, 'layouts'),
    }),
  );
  app.setViewEngine('hbs');

  // MCP clients may send JSON-RPC bodies; ensure JSON parser is available
  // Nest already enables json() by default.

  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8787);

  await app.listen(port, host);
  console.log(`wt.ai listening on http://${host}:${port}`);
  console.log(`MCP endpoint: http://${host}:${port}/mcp`);
}

void bootstrap();
