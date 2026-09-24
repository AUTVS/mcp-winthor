import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type McpClientId =
  'cursor' | 'claude-desktop' | 'claude-code' | 'chatgpt';

export interface McpClientConfigResult {
  ok: boolean;
  message: string;
  configPath: string;
  restartHint?: string;
}

type McpServerEntry = Record<string, unknown>;
type McpConfigFile = { mcpServers?: Record<string, McpServerEntry> };

@Injectable()
export class McpClientConfigService {
  configure(client: McpClientId, mcpUrl: string): McpClientConfigResult {
    const configPath = this.resolveConfigPath(client);
    const entry = this.buildServerEntry(client, mcpUrl);

    try {
      this.mergeAndWrite(configPath, entry);
      return {
        ok: true,
        message: `wt.ai configurado em ${configPath}`,
        configPath,
        restartHint: this.restartHint(client),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Falha ao configurar: ${message}`,
        configPath,
        restartHint: this.restartHint(client),
      };
    }
  }

  getSnippet(client: McpClientId, mcpUrl: string): string {
    const entry = this.buildServerEntry(client, mcpUrl);
    return JSON.stringify({ mcpServers: { 'wt.ai': entry } }, null, 2);
  }

  private resolveConfigPath(client: McpClientId): string {
    const home = homedir();

    switch (client) {
      case 'cursor':
        return join(home, '.cursor', 'mcp.json');
      case 'claude-code':
        return join(home, '.claude.json');
      case 'claude-desktop':
        if (process.platform === 'win32') {
          const appData =
            process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
          return join(appData, 'Claude', 'claude_desktop_config.json');
        }
        return join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        );
      case 'chatgpt':
        if (process.platform === 'win32') {
          const appData =
            process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
          return join(appData, 'OpenAI', 'ChatGPT', 'config.json');
        }
        return join(
          home,
          'Library',
          'Application Support',
          'OpenAI',
          'ChatGPT',
          'config.json',
        );
    }
  }

  private buildServerEntry(
    client: McpClientId,
    mcpUrl: string,
  ): McpServerEntry {
    switch (client) {
      case 'cursor':
        return { url: mcpUrl };
      case 'claude-code':
        return { type: 'http', url: mcpUrl };
      case 'claude-desktop':
        return {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpUrl, '--transport', 'http-only'],
        };
      case 'chatgpt':
        return { url: mcpUrl };
    }
  }

  private restartHint(client: McpClientId): string {
    switch (client) {
      case 'cursor':
        return 'Reinicie o Cursor para carregar o servidor MCP.';
      case 'claude-code':
        return 'Reinicie o Claude Code para carregar o servidor MCP.';
      case 'claude-desktop':
        return 'Reinicie o Claude Desktop. O bridge mcp-remote requer Node.js no PATH.';
      case 'chatgpt':
        return 'Reinicie o ChatGPT Desktop. Se não funcionar, use Settings → Apps/Connectors → Add custom connector com a URL do endpoint.';
    }
  }

  private mergeAndWrite(configPath: string, entry: McpServerEntry): void {
    const existing = this.readConfig(configPath);
    const merged: McpConfigFile = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers ?? {}),
        'wt.ai': entry,
      },
    };

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  private readConfig(configPath: string): McpConfigFile {
    if (!existsSync(configPath)) {
      return {};
    }
    const raw = readFileSync(configPath, 'utf-8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as McpConfigFile;
  }
}
