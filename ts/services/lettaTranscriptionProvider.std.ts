// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { LettaTranscriptionProvider } from '../types/LettaTranscription.std.ts';

export const LETTA_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
export const LETTA_TRANSCRIPTION_TIMEOUT_MS = 60_000;

type FetchType = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type ProviderDefinition = Readonly<{
  name: string;
  model: string;
  endpoint: string;
}>;

export const LETTA_TRANSCRIPTION_PROVIDER_DEFINITIONS: Readonly<
  Record<LettaTranscriptionProvider, ProviderDefinition>
> = {
  openai: {
    name: 'OpenAI',
    model: 'gpt-4o-transcribe',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  },
  groq: {
    name: 'Groq',
    model: 'whisper-large-v3-turbo',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
  },
  deepgram: {
    name: 'Deepgram',
    model: 'nova-3',
    endpoint: 'https://api.deepgram.com/v1/listen',
  },
};

type ErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'AUDIO_INVALID'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'EMPTY'
  | 'SERVICE';

export class LettaTranscriptionProviderError extends Error {
  public readonly code: ErrorCode;
  public readonly provider: LettaTranscriptionProvider;
  public readonly statusCode?: number;

  constructor(
    code: ErrorCode,
    provider: LettaTranscriptionProvider,
    statusCode?: number
  ) {
    super(
      `TRANSCRIPTION_${code}: ${provider}${statusCode ? ` (${statusCode})` : ''}`
    );
    this.name = 'LettaTranscriptionProviderError';
    this.code = code;
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

function fileExtension(contentType: string): string {
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') {
    return 'wav';
  }
  if (contentType === 'audio/mp4' || contentType === 'audio/x-m4a') {
    return 'm4a';
  }
  if (contentType === 'audio/webm') {
    return 'webm';
  }
  return 'mp3';
}

function responseText(
  provider: LettaTranscriptionProvider,
  value: unknown
): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (provider === 'openai' || provider === 'groq') {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  const channels = (value as { results?: { channels?: unknown } }).results
    ?.channels;
  if (!Array.isArray(channels)) {
    return undefined;
  }
  const alternatives = (channels[0] as { alternatives?: unknown } | undefined)
    ?.alternatives;
  if (!Array.isArray(alternatives)) {
    return undefined;
  }
  const transcript = (alternatives[0] as { transcript?: unknown } | undefined)
    ?.transcript;
  return typeof transcript === 'string' ? transcript : undefined;
}

function statusError(
  provider: LettaTranscriptionProvider,
  statusCode: number
): LettaTranscriptionProviderError {
  if (statusCode === 401 || statusCode === 403) {
    return new LettaTranscriptionProviderError('AUTH', provider, statusCode);
  }
  if (statusCode === 429) {
    return new LettaTranscriptionProviderError(
      'RATE_LIMIT',
      provider,
      statusCode
    );
  }
  if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
    return new LettaTranscriptionProviderError(
      'AUDIO_INVALID',
      provider,
      statusCode
    );
  }
  return new LettaTranscriptionProviderError('SERVICE', provider, statusCode);
}

export async function transcribeAudioWithProvider({
  provider,
  apiKey,
  data,
  contentType,
  fetch: fetchImplementation = globalThis.fetch.bind(globalThis),
  timeoutMs = LETTA_TRANSCRIPTION_TIMEOUT_MS,
}: Readonly<{
  provider: LettaTranscriptionProvider;
  apiKey: string;
  data: Uint8Array<ArrayBuffer>;
  contentType: string;
  fetch?: FetchType;
  timeoutMs?: number;
}>): Promise<string> {
  if (
    data.byteLength === 0 ||
    data.byteLength > LETTA_TRANSCRIPTION_MAX_BYTES
  ) {
    throw new LettaTranscriptionProviderError('AUDIO_INVALID', provider);
  }

  const definition = LETTA_TRANSCRIPTION_PROVIDER_DEFINITIONS[provider];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = definition.endpoint;
    let headers: HeadersInit;
    let body: BodyInit;

    if (provider === 'deepgram') {
      const endpoint = new URL(url);
      endpoint.searchParams.set('model', definition.model);
      endpoint.searchParams.set('smart_format', 'true');
      url = endpoint.toString();
      headers = {
        Accept: 'application/json',
        Authorization: `Token ${apiKey}`,
        'Content-Type': contentType,
      };
      body = new Blob([data], { type: contentType });
    } else {
      const form = new FormData();
      form.append(
        'file',
        new Blob([data], { type: contentType }),
        `voice-message.${fileExtension(contentType)}`
      );
      form.append('model', definition.model);
      form.append('response_format', 'json');
      headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      body = form;
    }

    const response = await fetchImplementation(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw statusError(provider, response.status);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new LettaTranscriptionProviderError('SERVICE', provider);
    }
    const text = responseText(provider, parsed)?.trim();
    if (!text) {
      throw new LettaTranscriptionProviderError('EMPTY', provider);
    }
    return text;
  } catch (error) {
    if (error instanceof LettaTranscriptionProviderError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new LettaTranscriptionProviderError('TIMEOUT', provider);
    }
    throw new LettaTranscriptionProviderError('NETWORK', provider);
  } finally {
    clearTimeout(timeout);
  }
}
