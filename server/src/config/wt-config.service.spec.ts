import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WtConfigService } from './wt-config.service';

describe('WtConfigService', () => {
  const configPath = join(process.cwd(), 'data', 'config.json');
  let service: WtConfigService;

  beforeEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    service = new WtConfigService();
  });

  afterEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it('hashes password with WTA MD5 uppercase rule', () => {
    expect(service.md5Wta('teste')).toBe('99A29DC8105FD2FA39D8CDC04733938D');
  });

  it('persists config without plain password', () => {
    const saved = service.saveFromForm({
      winthorBaseUrl: 'http://10.0.0.242:8181/',
      login: 'demo',
      senha: 'teste',
    });

    expect(saved.winthorBaseUrl).toBe('http://10.0.0.242:8181');
    expect(saved.login).toBe('demo');
    expect(saved.senhaMd5).toBe('99A29DC8105FD2FA39D8CDC04733938D');
    expect(service.isConfigured()).toBe(true);
  });

  it('rejects invalid base URL with path', () => {
    expect(() =>
      service.saveFromForm({
        winthorBaseUrl: 'http://host/path',
        login: 'demo',
        senha: 'x',
      }),
    ).toThrow(/caminho/);
  });
});
