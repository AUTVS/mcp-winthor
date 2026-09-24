import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { engine } from 'express-handlebars';

import { join } from 'node:path';
import { AppModule } from './../src/app.module';

/**
 * Este spec sobe o `AppModule` INTEIRO, então o isolamento do ambiente é
 * obrigatório, não higiene opcional — ver `test/e2e-setup.ts`, que roda antes de
 * qualquer import da aplicação. Sem ele, a suíte escreve na base local de vendas
 * de verdade e dispara uma varredura contra o ERP de produção da máquina.
 *
 * A guarda abaixo falha alto se alguém remover o `setupFiles`: um e2e que
 * silenciosamente aponta para os dados reais é pior que um e2e quebrado.
 */
describe('wt.ai (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(() => {
    const dir = process.env.WTA_DATA_DIR;
    if (!dir || !dir.includes('wtai-e2e-')) {
      throw new Error(
        'e2e sem isolamento: WTA_DATA_DIR não aponta para um diretório temporário. ' +
          'Confira "setupFiles" em test/jest-e2e.json.',
      );
    }
    if (process.env.WTA_INGESTAO_AUTO !== '0') {
      throw new Error(
        'e2e com sincronização automática ligada: varreria o ERP de produção.',
      );
    }
  });

  // Sem `rmSync` do diretório temporário de propósito: o DuckDB ainda finaliza
  // escrita depois do `app.close()`, e apagar o `.wal` embaixo dele derruba o
  // processo com uma exceção não capturada — falha de teardown que parece falha de
  // teste. O diretório fica em `os.tmpdir()`, que o sistema recolhe.

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const nestApp = app as NestExpressApplication;
    const viewsPath = join(__dirname, '..', 'views');
    nestApp.useStaticAssets(join(__dirname, '..', 'public'));
    nestApp.setBaseViewsDir(viewsPath);
    nestApp.engine(
      'hbs',
      engine({
        extname: '.hbs',
        defaultLayout: 'main',
        layoutsDir: join(viewsPath, 'layouts'),
      }),
    );
    nestApp.setViewEngine('hbs');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/ (GET) returns setup page when not configured', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect((res) => {
        expect(res.text).toContain('wt.ai');
        expect(res.text).toContain('URL base do WinThor');
      });
  });

  it('/mcp (GET) returns 503 when not configured', () => {
    return request(app.getHttpServer())
      .get('/mcp')
      .expect(503)
      .expect((res) => {
        expect(res.body.error).toBe('not_configured');
      });
  });
});
