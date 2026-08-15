// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Electron's Chromium fetch is blocked by Cloudflare on api.letta.com
// (error 1010). Use Node's HTTPS stack from the unsandboxed preload instead.

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

function headerValue(value: string | Array<string> | undefined): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value ?? '';
}

export async function lettaNodeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const url = new URL(
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url
  );
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) {
    headers.set(
      'user-agent',
      'SignalLetta/0.1 (+https://github.com/letta-ai/signal-desktop-app)'
    );
  }

  let body: Buffer<ArrayBuffer> | undefined;
  if (init.body != null) {
    const bodyResponse = new Response(init.body);
    body = Buffer.from(await bodyResponse.arrayBuffer());
    const contentType = bodyResponse.headers.get('content-type');
    if (contentType && !headers.has('content-type')) {
      headers.set('content-type', contentType);
    }
  }
  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(body.byteLength));
  }

  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers: requestHeaders,
      },
      response => {
        const chunks: Array<Buffer<ArrayBuffer>> = [];
        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value != null) {
              responseHeaders.set(key, headerValue(value));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
            })
          );
        });
      }
    );
    request.on('error', reject);
    if (init.signal) {
      const abort = () => {
        request.destroy(new Error('Aborted'));
      };
      if (init.signal.aborted) {
        abort();
        return;
      }
      init.signal.addEventListener('abort', abort, { once: true });
    }
    if (body) {
      request.write(body);
    }
    request.end();
  });
}
