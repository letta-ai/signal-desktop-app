// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  LettaOAuthError,
  LETTA_OAUTH_CLIENT_ID,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  revokeToken,
  validateAccessToken,
} from '../../services/lettaOAuthProvider.std.ts';

type RecordedRequest = Readonly<{
  url: string;
  body: Record<string, unknown>;
}>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

// A fetch double that answers from a fixed script of JSON responses and
// records each request for assertions.
function scriptedFetch(
  responses: Array<{ status: number; body: unknown; contentType?: string }>
): { fetch: typeof fetch; calls: Array<RecordedRequest> } {
  const queue = [...responses];
  const calls: Array<RecordedRequest> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    let parsedBody: Record<string, unknown> = {};
    const rawBody = init?.body;
    if (typeof rawBody === 'string') {
      try {
        parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsedBody = {};
      }
    }
    calls.push({ url: requestUrl(input), body: parsedBody });
    const next = queue.shift();
    if (!next) {
      throw new Error('unexpected extra request');
    }
    return Response.json(next.body, {
      status: next.status,
      headers: { 'Content-Type': next.contentType ?? 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

function lastCall(calls: Array<RecordedRequest>): RecordedRequest {
  const call = calls.at(-1);
  if (!call) {
    throw new Error('expected at least one recorded request');
  }
  return call;
}

function expectOAuthError(error: unknown, kind: LettaOAuthError['kind']): void {
  assert.instanceOf(error, LettaOAuthError);
  assert.strictEqual(error.kind, kind);
}

const DEVICE_CODE_RESPONSE = {
  device_code: 'device-code-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://app.letta.com/oauth/device',
  verification_uri_complete:
    'https://app.letta.com/oauth/device?code=ABCD-1234',
  expires_in: 900,
  interval: 5,
};

const TOKENS = {
  access_token: 'at',
  refresh_token: 'rt',
  token_type: 'Bearer',
  expires_in: 3600,
};

describe('Letta OAuth provider', () => {
  describe('requestDeviceCode', () => {
    it('posts the client id and normalizes the response', async () => {
      const { fetch, calls } = scriptedFetch([
        { status: 200, body: DEVICE_CODE_RESPONSE },
      ]);

      const device = await requestDeviceCode({ fetch });

      assert.strictEqual(device.device_code, 'device-code-1');
      assert.strictEqual(device.user_code, 'ABCD-1234');
      assert.strictEqual(device.interval, 5);
      assert.strictEqual(device.expires_in, 900);
      assert.lengthOf(calls, 1);
      const call = lastCall(calls);
      assert.strictEqual(
        call.url,
        'https://app.letta.com/api/oauth/device/code'
      );
      assert.deepStrictEqual(call.body, { client_id: LETTA_OAUTH_CLIENT_ID });
    });

    it('fills in defaults for missing optional fields', async () => {
      const { fetch } = scriptedFetch([
        {
          status: 200,
          body: {
            device_code: 'd',
            user_code: 'u',
            verification_uri: 'https://app.letta.com/d',
          },
        },
      ]);

      const device = await requestDeviceCode({ fetch });

      assert.equal(device.expires_in, 900);
      assert.equal(device.interval, 5);
      assert.equal(device.verification_uri_complete, 'https://app.letta.com/d');
    });

    it('rejects non-https verification URLs', async () => {
      const { fetch } = scriptedFetch([
        {
          status: 200,
          body: {
            ...DEVICE_CODE_RESPONSE,
            verification_uri: 'http://evil.test',
          },
        },
      ]);

      try {
        await requestDeviceCode({ fetch });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'malformed-response');
      }
    });

    it('retries transient server errors a bounded number of times', async () => {
      const { fetch, calls } = scriptedFetch([
        { status: 500, body: {} },
        { status: 503, body: {} },
        { status: 500, body: {} },
      ]);

      try {
        await requestDeviceCode({ fetch });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'transient');
      }
      assert.lengthOf(calls, 3);
    });

    it('surfaces non-transient failures without retrying', async () => {
      let callCount = 0;
      const failing: typeof fetch = async () => {
        callCount += 1;
        return Response.json({ error: 'unauthorized_client' }, { status: 401 });
      };

      try {
        await requestDeviceCode({ fetch: failing });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'request-failed');
      }
      assert.strictEqual(callCount, 1);
    });
  });

  describe('pollForToken', () => {
    it('waits through authorization_pending then returns tokens', async () => {
      const { fetch, calls } = scriptedFetch([
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: TOKENS },
      ]);

      const tokens = await pollForToken('dc', {
        deviceId: 'dev-1',
        intervalSeconds: 0,
        expiresInSeconds: 5,
        fetch,
      });

      assert.strictEqual(tokens.access_token, 'at');
      assert.strictEqual(tokens.refresh_token, 'rt');
      assert.lengthOf(calls, 3);
      const pollBody = lastCall(calls).body;
      assert.strictEqual(pollBody.device_code, 'dc');
      assert.strictEqual(
        pollBody.grant_type,
        'urn:ietf:params:oauth:grant-type:device_code'
      );
      assert.strictEqual(pollBody.client_id, LETTA_OAUTH_CLIENT_ID);
      assert.strictEqual(pollBody.device_id, 'dev-1');
    });

    it('rejects token responses without a valid expiration', async () => {
      const { fetch } = scriptedFetch([
        {
          status: 200,
          body: { access_token: 'at', token_type: 'Bearer' },
        },
      ]);

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          expiresInSeconds: 5,
          fetch,
        });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'malformed-response');
      }
    });

    it('backs off after slow_down and still succeeds', async () => {
      const { fetch, calls } = scriptedFetch([
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: TOKENS },
      ]);

      // The deadline must outlast the five-second slow_down backoff.
      const tokens = await pollForToken('dc', {
        deviceId: 'dev-1',
        intervalSeconds: 0,
        expiresInSeconds: 30,
        fetch,
      });
      assert.strictEqual(tokens.access_token, 'at');
      assert.lengthOf(calls, 3);
    }).timeout(15000);

    it('throws denied when the user denies authorization', async () => {
      const { fetch } = scriptedFetch([
        { status: 400, body: { error: 'access_denied' } },
      ]);

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          fetch,
        });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'denied');
      }
    });

    it('throws expired once the deadline passes', async () => {
      const pendingForever: typeof fetch = async () =>
        Response.json({ error: 'authorization_pending' }, { status: 400 });

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          expiresInSeconds: 0,
          fetch: pendingForever,
        });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'expired');
      }
    });

    it('bounds transient server failures while polling', async () => {
      const { fetch, calls } = scriptedFetch([
        { status: 500, body: {} },
        { status: 429, body: {} },
        { status: 503, body: {} },
      ]);

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          expiresInSeconds: 30,
          fetch,
        });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'transient');
      }
      assert.lengthOf(calls, 3);
    });

    it('stops with cancelled when the signal aborts', async () => {
      const controller = new AbortController();
      const { fetch, calls } = scriptedFetch([
        { status: 400, body: { error: 'authorization_pending' } },
      ]);
      // The long poll interval parks the loop in its sleep; the abort must
      // cut that sleep short instead of waiting out the interval.
      setTimeout(() => controller.abort(), 10);

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 60,
          expiresInSeconds: 300,
          fetch,
          signal: controller.signal,
        });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'cancelled');
      }
      assert.isAtMost(calls.length, 2);
    });

    it('does not leak malformed response bodies into errors', async () => {
      const malformed: typeof fetch = async () =>
        new Response('{not json at all', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          expiresInSeconds: 5,
          fetch: malformed,
        });
        assert.fail('expected rejection');
      } catch (error) {
        assert.instanceOf(error, LettaOAuthError);
        assert.notInclude(error.message.toLowerCase(), 'not json');
        assert.notInclude(error.message, '{');
      }
    });

    it('does not leak non-JSON bodies into errors', async () => {
      const html: typeof fetch = async () =>
        new Response('<html>gateway error hunter2</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });

      try {
        await pollForToken('dc', {
          deviceId: 'dev-1',
          intervalSeconds: 0,
          expiresInSeconds: 5,
          fetch: html,
        });
        assert.fail('expected rejection');
      } catch (error) {
        assert.instanceOf(error, LettaOAuthError);
        assert.notInclude(error.message, 'hunter2');
        assert.notInclude(error.message, '<html>');
      }
    });
  });

  describe('refreshAccessToken', () => {
    it('requests rotation and returns the rotated tokens', async () => {
      const { fetch, calls } = scriptedFetch([
        {
          status: 200,
          body: {
            access_token: 'at2',
            refresh_token: 'rt2',
            token_type: 'Bearer',
            expires_in: 7200,
          },
        },
      ]);

      const tokens = await refreshAccessToken('rt1', {
        deviceId: 'dev-1',
        deviceName: 'Signal Letta on macOS',
        fetch,
      });

      assert.strictEqual(tokens.access_token, 'at2');
      assert.strictEqual(tokens.refresh_token, 'rt2');
      const body = lastCall(calls).body;
      assert.strictEqual(body.grant_type, 'refresh_token');
      assert.strictEqual(body.refresh_token, 'rt1');
      assert.strictEqual(body.refresh_token_mode, 'new');
      assert.strictEqual(body.device_name, 'Signal Letta on macOS');
    });

    it('maps invalid_grant so stored auth can be cleared', async () => {
      const { fetch } = scriptedFetch([
        { status: 400, body: { error: 'invalid_grant' } },
      ]);

      try {
        await refreshAccessToken('rt', { deviceId: 'dev-1', fetch });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'invalid-grant');
      }
    });

    it('classifies transient refresh failures as retryable', async () => {
      const { fetch } = scriptedFetch([{ status: 502, body: {} }]);

      try {
        await refreshAccessToken('rt', { deviceId: 'dev-1', fetch });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'transient');
      }
    });

    it('does not include server descriptions with credentials in errors', async () => {
      const { fetch } = scriptedFetch([
        {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: 'token sk-let-secret was revoked',
          },
        },
      ]);

      try {
        await refreshAccessToken('rt', { deviceId: 'dev-1', fetch });
        assert.fail('expected rejection');
      } catch (error) {
        expectOAuthError(error, 'invalid-grant');
        // The description is sanitized but must never be a raw token echo.
        assert.notInclude(
          (error as Error).message,
          'sk-let-secret was revoked'
        );
      }
    });
  });

  describe('revokeToken', () => {
    it('never throws even if revocation fails', async () => {
      const offline: typeof fetch = async () => {
        throw new TypeError('fetch failed');
      };

      await revokeToken('rt', { fetch: offline });
    });
  });

  describe('validateAccessToken', () => {
    it('accepts a working token', async () => {
      const ok: typeof fetch = async () => Response.json([]);
      const result = await validateAccessToken('at', { fetch: ok });
      assert.isTrue(result.ok);
    });

    it('rejects an invalid token as invalid', async () => {
      const unauthorized: typeof fetch = async () =>
        new Response(null, { status: 401 });
      const result = await validateAccessToken('bad', { fetch: unauthorized });
      assert.deepEqual(result, { ok: false, reason: 'invalid' });
    });

    it('treats server errors as transient', async () => {
      const unavailable: typeof fetch = async () =>
        new Response(null, { status: 503 });
      const result = await validateAccessToken('at', { fetch: unavailable });
      assert.deepEqual(result, { ok: false, reason: 'transient' });
    });

    it('treats network failures as transient', async () => {
      const offline: typeof fetch = async () => {
        throw new TypeError('fetch failed');
      };
      const result = await validateAccessToken('at', { fetch: offline });
      assert.deepEqual(result, { ok: false, reason: 'transient' });
    });
  });
});
