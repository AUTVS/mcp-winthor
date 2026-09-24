export interface WtConfig {
  winthorBaseUrl: string;
  login: string;
  senhaMd5: string;
  configuredAt: string;
}

export interface SetupFormInput {
  winthorBaseUrl: string;
  login: string;
  senha: string;
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      'URL base inválida. Use http://host:porta ou https://host:porta.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL base deve usar http ou https.');
  }
  if (url.pathname && url.pathname !== '/') {
    throw new Error('URL base não deve incluir caminho (path).');
  }
  return `${url.protocol}//${url.host}`;
}
