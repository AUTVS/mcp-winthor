import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { McpClientConfigService } from './mcp-client-config.service';

const tmpHome = join(process.cwd(), 'data', 'mcp-test-home');

jest.mock('node:os', () => ({
  homedir: () => tmpHome,
}));

describe('McpClientConfigService', () => {
  let service: McpClientConfigService;
  const mcpUrl = 'http://127.0.0.1:8787/mcp';

  beforeEach(() => {
    service = new McpClientConfigService();
    rmSync(tmpHome, { recursive: true, force: true });
    mkdirSync(tmpHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('merges wt.ai into existing mcpServers without removing others', () => {
    const configPath = join(tmpHome, '.cursor', 'mcp.json');
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          other: { url: 'http://example.com/mcp' },
        },
      }),
      'utf-8',
    );

    const result = service.configure('cursor', mcpUrl);

    expect(result.ok).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.mcpServers.other).toEqual({ url: 'http://example.com/mcp' });
    expect(saved.mcpServers['wt.ai']).toEqual({ url: mcpUrl });
  });

  it('creates cursor config with url entry', () => {
    const configPath = join(tmpHome, '.cursor', 'mcp.json');
    const result = service.configure('cursor', mcpUrl);

    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.mcpServers['wt.ai']).toEqual({ url: mcpUrl });
  });

  it('creates claude-code config with type http', () => {
    const configPath = join(tmpHome, '.claude.json');
    service.configure('claude-code', mcpUrl);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.mcpServers['wt.ai']).toEqual({
      type: 'http',
      url: mcpUrl,
    });
  });

  it('creates claude-desktop config with mcp-remote bridge', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    try {
      const configPath = join(
        tmpHome,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      );
      service.configure('claude-desktop', mcpUrl);

      const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(saved.mcpServers['wt.ai']).toEqual({
        command: 'npx',
        args: ['-y', 'mcp-remote', mcpUrl, '--transport', 'http-only'],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
