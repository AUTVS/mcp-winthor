import { Logger } from '@nestjs/common';
import { MAX_RESULT_CHARS } from '../../config/limits';
import { WinthorApiResult } from '../../winthor/winthor-api.service';

/**
 * Ponto único de saída das tools MCP.
 *
 * Toda tool passa por aqui antes de responder. Três garantias:
 *
 * 1. JSON compacto — o pretty-print anterior inflava o payload em 2-3x.
 * 2. Orçamento de caracteres — nenhuma resposta ultrapassa MAX_RESULT_CHARS.
 * 3. Truncamento avisado — ao estourar, corta linhas e devolve `truncated`,
 *    `returned` e um `hint` de como refinar. Nunca vira erro, nunca corta em
 *    silêncio.
 *
 * `isError` vem exclusivamente da flag do caller: truncar não é falha.
 */

const logger = new Logger('ToolResult');

/** Espaço reservado para as chaves de truncamento (`hint` é a maior). */
const HINT_RESERVE = 300;

/** Chaves que costumam carregar as linhas; o fallback é genérico. */
const PREFERRED_ROW_KEYS = ['items', 'filiais', 'clientes', 'pedidos'];

type Payload = Record<string, unknown>;

/**
 * `type` e não `interface`: o SDK tipa o retorno com index signature, e
 * interfaces não são atribuíveis a esse formato.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};

/** Envelopa arrays e escalares para que o resto do fluxo veja sempre um objeto. */
function toEnvelope(payload: unknown): Payload {
  if (Array.isArray(payload)) return { items: payload };
  if (payload === null || typeof payload !== 'object')
    return { value: payload };
  return payload as Payload;
}

/** Acha o array de linhas: chaves preferidas primeiro, senão o primeiro array. */
export function findRowKey(envelope: Payload): string | null {
  for (const chave of PREFERRED_ROW_KEYS) {
    if (Array.isArray(envelope[chave])) return chave;
  }
  for (const [chave, valor] of Object.entries(envelope)) {
    if (Array.isArray(valor)) return chave;
  }
  return null;
}

function buildHint(
  envelope: Payload,
  mantidas: number,
  originais: number,
  extra?: string,
): string {
  const partes = [
    `Resultado cortado em ${mantidas} de ${originais} linhas por limite de tamanho.`,
  ];

  // NUNCA mandar pedir a próxima página aqui. As linhas descartadas ficam entre
  // esta página e a seguinte: `page+1` no upstream salta por cima delas e elas
  // se tornam inalcançáveis. O único conselho correto é repetir a MESMA página
  // com um tamanho que caiba.
  partes.push(
    mantidas > 0
      ? `Repita a mesma página com pageSize=${mantidas}.`
      : 'Reduza pageSize e refine os filtros.',
  );

  if (extra) partes.push(extra);
  // Preserva uma dica que a própria tool já tenha colocado no payload.
  if (typeof envelope.hint === 'string') partes.push(envelope.hint);

  return partes.join(' ');
}

function envelopeToResult(envelope: Payload, isError: boolean): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError,
  };
}

/**
 * Último recurso: o payload estourou e não há array para cortar (tools
 * escalares), ou o envelope sozinho já não cabe. Devolve JSON válido e limitado.
 */
function previewResult(
  envelope: Payload,
  texto: string,
  isError: boolean,
): ToolResult {
  // Metade do orçamento porque o preview será re-escapado dentro do JSON.
  const limite = Math.max(0, Math.floor((MAX_RESULT_CHARS - HINT_RESERVE) / 2));
  return envelopeToResult(
    {
      ok: envelope.ok ?? !isError,
      truncated: true,
      hint: 'Payload excedeu o limite de tamanho e foi cortado. Refine os filtros ou use page/pageSize.',
      preview: texto.slice(0, limite),
    },
    isError,
  );
}

/**
 * Aplica o orçamento a um payload já montado.
 *
 * @param hintExtra dica específica da tool, anexada ao aviso de truncamento.
 */
export function shapeToolResult(
  payload: unknown,
  isError = false,
  hintExtra?: string,
): ToolResult {
  const envelope = toEnvelope(payload);
  const texto = JSON.stringify(envelope);

  if (texto.length <= MAX_RESULT_CHARS) {
    return envelopeToResult(envelope, isError);
  }

  const rowKey = findRowKey(envelope);
  if (!rowKey) {
    return previewResult(envelope, texto, isError);
  }

  const linhas = envelope[rowKey] as unknown[];

  // Overhead do envelope sem as linhas, medido uma vez.
  const overhead = JSON.stringify({ ...envelope, [rowKey]: [] }).length;
  const orcamento = MAX_RESULT_CHARS - overhead - HINT_RESERVE;

  // Uma passada, uma serialização por linha. Busca binária re-serializando o
  // payload inteiro seria ordens de grandeza mais cara aqui.
  let usado = 0;
  let mantidas = 0;
  for (const linha of linhas) {
    const tamanho = JSON.stringify(linha).length + 1;
    if (usado + tamanho > orcamento) break;
    usado += tamanho;
    mantidas++;
  }

  const cortado: Payload = {
    ...envelope,
    [rowKey]: linhas.slice(0, mantidas),
    truncated: true,
    returned: mantidas,
    hint: buildHint(envelope, mantidas, linhas.length, hintExtra),
  };

  // `count` significa "linhas nesta resposta" — mantê-lo original seria mentir.
  if (typeof envelope.count === 'number') cortado.count = mantidas;

  logger.warn(
    `payload truncado: ${mantidas}/${linhas.length} linhas, ${texto.length} chars > ${MAX_RESULT_CHARS}`,
  );

  const textoFinal = JSON.stringify(cortado);
  if (textoFinal.length > MAX_RESULT_CHARS) {
    // Uma única linha maior que o orçamento inteiro.
    return previewResult(envelope, textoFinal, isError);
  }

  return envelopeToResult(cortado, isError);
}

/**
 * Adaptador para o contrato `WinthorApiResult`. Assinatura idêntica à função
 * privada que existia em mobile-tools.ts, para os 21 call sites não mudarem.
 */
export function toToolResult(
  result: WinthorApiResult<unknown>,
  hintExtra?: string,
): ToolResult {
  if (!result.ok) {
    return shapeToolResult(
      {
        ok: false,
        status: result.status,
        error: result.error,
        raw: result.raw,
      },
      true,
    );
  }

  const data = result.data;
  const payload: Payload = Array.isArray(data)
    ? { ok: true, items: data }
    : data !== null && typeof data === 'object'
      ? { ok: true, ...(data as Payload) }
      : { ok: true, value: data };

  return shapeToolResult(payload, false, hintExtra);
}
