// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  LettaTranscriptionProviderError,
  transcribeAudioWithProvider,
} from '../../services/lettaTranscriptionProvider.std.ts';

const AUDIO = new Uint8Array([1, 2, 3]);
const API_KEY = 'test-api-key';

function requestUrlForInput(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('Letta transcription providers', () => {
  it('builds an OpenAI multipart request', async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const text = await transcribeAudioWithProvider({
      provider: 'openai',
      apiKey: API_KEY,
      data: AUDIO,
      contentType: 'audio/mpeg',
      fetch: async (input, init) => {
        requestUrl = requestUrlForInput(input);
        requestInit = init;
        return Response.json({ text: '  hello from OpenAI  ' });
      },
    });

    assert.strictEqual(text, 'hello from OpenAI');
    assert.strictEqual(
      requestUrl,
      'https://api.openai.com/v1/audio/transcriptions'
    );
    const headers = new Headers(requestInit?.headers);
    assert.strictEqual(headers.get('authorization'), `Bearer ${API_KEY}`);
    const form = requestInit?.body;
    assert.instanceOf(form, FormData);
    assert.strictEqual(form.get('model'), 'gpt-4o-transcribe');
    const file = form.get('file');
    assert.instanceOf(file, File);
    assert.strictEqual(file.name, 'voice-message.mp3');
  });

  it('builds a Groq multipart request', async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const text = await transcribeAudioWithProvider({
      provider: 'groq',
      apiKey: API_KEY,
      data: AUDIO,
      contentType: 'audio/mpeg',
      fetch: async (input, init) => {
        requestUrl = requestUrlForInput(input);
        requestInit = init;
        return Response.json({ text: 'hello from Groq' });
      },
    });

    assert.strictEqual(text, 'hello from Groq');
    assert.strictEqual(
      requestUrl,
      'https://api.groq.com/openai/v1/audio/transcriptions'
    );
    const headers = new Headers(requestInit?.headers);
    assert.strictEqual(headers.get('authorization'), `Bearer ${API_KEY}`);
    const form = requestInit?.body;
    assert.instanceOf(form, FormData);
    assert.strictEqual(form.get('model'), 'whisper-large-v3-turbo');
  });

  it('builds a Deepgram raw audio request', async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const text = await transcribeAudioWithProvider({
      provider: 'deepgram',
      apiKey: API_KEY,
      data: AUDIO,
      contentType: 'audio/mpeg',
      fetch: async (input, init) => {
        requestUrl = requestUrlForInput(input);
        requestInit = init;
        return Response.json({
          results: {
            channels: [
              { alternatives: [{ transcript: ' hello from Deepgram ' }] },
            ],
          },
        });
      },
    });

    assert.strictEqual(text, 'hello from Deepgram');
    if (requestUrl === undefined) {
      throw new Error('Expected a Deepgram request URL');
    }
    const url = new URL(requestUrl);
    assert.strictEqual(
      url.origin + url.pathname,
      'https://api.deepgram.com/v1/listen'
    );
    assert.strictEqual(url.searchParams.get('model'), 'nova-3');
    assert.strictEqual(url.searchParams.get('smart_format'), 'true');
    const headers = new Headers(requestInit?.headers);
    assert.strictEqual(headers.get('authorization'), `Token ${API_KEY}`);
    assert.strictEqual(headers.get('content-type'), 'audio/mpeg');
    assert.instanceOf(requestInit?.body, Blob);
  });

  it('classifies authentication failures without returning the response body', async () => {
    const promise = transcribeAudioWithProvider({
      provider: 'openai',
      apiKey: API_KEY,
      data: AUDIO,
      contentType: 'audio/mpeg',
      fetch: async () =>
        new Response('sensitive provider response', { status: 401 }),
    });

    await assert.isRejected(
      promise,
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_AUTH: openai (401)'
    );
    await promise.catch(error => {
      assert.notInclude(String(error), 'sensitive provider response');
    });
  });

  it('rejects an empty transcript', async () => {
    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'groq',
        apiKey: API_KEY,
        data: AUDIO,
        contentType: 'audio/mpeg',
        fetch: async () => Response.json({ text: '   ' }),
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_EMPTY: groq'
    );
  });

  it('rejects empty and oversized audio before sending a request', async () => {
    let requestCount = 0;
    const fetch = async (): Promise<Response> => {
      requestCount += 1;
      return Response.json({ text: 'unexpected' });
    };

    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'openai',
        apiKey: API_KEY,
        data: new Uint8Array(),
        contentType: 'audio/mpeg',
        fetch,
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_AUDIO_INVALID: openai'
    );
    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'groq',
        apiKey: API_KEY,
        data: new Uint8Array(25 * 1024 * 1024 + 1),
        contentType: 'audio/mpeg',
        fetch,
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_AUDIO_INVALID: groq'
    );
    assert.strictEqual(requestCount, 0);
  });

  it('classifies rate limits and network failures', async () => {
    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'deepgram',
        apiKey: API_KEY,
        data: AUDIO,
        contentType: 'audio/mpeg',
        fetch: async () => new Response(null, { status: 429 }),
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_RATE_LIMIT: deepgram (429)'
    );
    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'openai',
        apiKey: API_KEY,
        data: AUDIO,
        contentType: 'audio/mpeg',
        fetch: async () => {
          throw new Error('network failed with sensitive details');
        },
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_NETWORK: openai'
    );
  });

  it('aborts a transcription request after the timeout', async () => {
    await assert.isRejected(
      transcribeAudioWithProvider({
        provider: 'groq',
        apiKey: API_KEY,
        data: AUDIO,
        contentType: 'audio/mpeg',
        timeoutMs: 1,
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      }),
      LettaTranscriptionProviderError,
      'TRANSCRIPTION_TIMEOUT: groq'
    );
  });
});
