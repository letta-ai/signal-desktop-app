// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

// Borrowed from Letta Code's thinking-messages list, plus metacognating.
const THINKING_VERBS = Object.freeze([
  'thinking',
  'processing',
  'computing',
  'calculating',
  'analyzing',
  'synthesizing',
  'deliberating',
  'cogitating',
  'metacognating',
  'reflecting',
  'reasoning',
  'spinning',
  'focusing',
  'machinating',
  'contemplating',
  'ruminating',
  'considering',
  'pondering',
  'evaluating',
  'assessing',
  'inferring',
  'deducing',
  'interpreting',
  'formulating',
  'strategizing',
  'orchestrating',
  'optimizing',
  'calibrating',
  'indexing',
  'compiling',
  'rendering',
  'executing',
  'initializing',
  'absolutely right',
  'thinking about thinking',
  'metathinking',
  'learning',
  'adapting',
  'evolving',
  'remembering',
  'absorbing',
  'internalizing',
] as const);

export type LettaToolStatusInput = Readonly<{
  toolName: string;
  toolInput?: Record<string, unknown>;
}>;

function uncapitalize(value: string): string {
  if (!value) {
    return value;
  }
  const first = value[0];
  if (!first || first < 'A' || first > 'Z') {
    return value;
  }
  const second = value[1];
  if (second && second >= 'A' && second <= 'Z') {
    return value;
  }
  return first.toLowerCase() + value.slice(1);
}

function readToolDescription(
  toolInput: Record<string, unknown> | undefined
): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  for (const key of ['description', 'justification'] as const) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getRandomThinkingVerb(): string {
  const index = Math.floor(Math.random() * THINKING_VERBS.length);
  return THINKING_VERBS[index] ?? 'thinking';
}

export function formatLettaToolStatus(tool: LettaToolStatusInput): string {
  return readToolDescription(tool.toolInput) ?? tool.toolName;
}

export function formatLettaWorkingLine(
  agentName: string,
  tool?: LettaToolStatusInput,
  thinkingVerb: string = getRandomThinkingVerb()
): string {
  const name = agentName.trim() || 'Agent';
  if (!tool) {
    return `${name} is ${thinkingVerb}`;
  }
  const description = readToolDescription(tool.toolInput);
  if (description) {
    return `${name} is ${uncapitalize(description)}`;
  }
  return `${name} is using ${formatLettaToolStatus(tool)}`;
}

export function formatLettaQuotedSend(
  text: string,
  quoteText?: string
): string {
  const quoted = quoteText?.trim();
  if (!quoted) {
    return text;
  }
  const snippet = quoted.length > 280 ? `${quoted.slice(0, 279)}…` : quoted;
  const prefix = `Replying to: "${snippet}"`;
  return text ? `${prefix}\n\n${text}` : prefix;
}

export function formatLettaReactionSend(
  emoji: string,
  remove: boolean,
  targetText?: string
): string {
  const snippet = (targetText ?? '').trim();
  const clipped = snippet.length > 280 ? `${snippet.slice(0, 279)}…` : snippet;
  if (remove) {
    return clipped ? `Removed ${emoji} from: "${clipped}"` : `Removed ${emoji}`;
  }
  return clipped ? `Reacted ${emoji} to: "${clipped}"` : `Reacted ${emoji}`;
}
