// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Letta Cloud OAuth 2.0 Device Authorization Grant protocol operations.
//
// Pure protocol module: every network call goes through an injectable fetch so
// tests never hit the real service. Errors are typed and sanitized; response
// bodies are never read into error messages because they may contain
// credentials.

export const LETTA_OAUTH_CLIENT_ID = 'ci-let-94bf2d5e34984a684fb6b18880b6bc7d';

export const LETTA_OAUTH_AUTH_BASE_URL = 'https://app.letta.com';
export const LETTA_OAUTH_API_BASE_URL = 'https://api.letta.com';

const DEVICE_CODE_PATH = '/api/oauth/device/code';
const TOKEN_PATH = '/api/oauth/token';
const REVOKE_PATH = '/api/oauth/revoke';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const DEVICE_CODE_REQUEST_MAX_ATTEMPTS = 3;
const DEVICE_CODE_RETRY_DELAY_MS = 250;
const TOKEN_POLL_TRANSIENT_FAILURE_LIMIT = 2;
const SLOW_DOWN_EXTRA_MS = 5000;
const MAX_ERROR_DESCRIPTION_LENGTH = 300;

type FetchLike = typeof fetch;

export type OAuthRequestOptions = {
  fetch?: FetchLike;
  signal?: AbortSignal;
};

export type DeviceCodeResponse = Readonly<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}>;

export type TokenResponse = Readonly<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}>;

export type LettaOAuthErrorKind =
  | 'cancelled'
  | 'request-failed'
  | 'denied'
  | 'expired'
  | 'transient'
  | 'invalid-grant'
  | 'malformed-response';

export class LettaOAuthError extends Error {
  readonly kind: LettaOAuthErrorKind;

  constructor(kind: LettaOAuthErrorKind, message: string) {
    super(message);
    this.name = 'LettaOAuthError';
    this.kind = kind;
  }
}

export type LettaTokenValidation =
  | { ok: true }
  | { ok: false; reason: 'transient' | 'invalid' };

function getFetch(options: OAuthRequestOptions): FetchLike {
  return options.fetch ?? fetch;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().slice(0, MAX_ERROR_DESCRIPTION_LENGTH);
  // Strip control characters so server text can never forge log lines.
  const cleaned = trimmed.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return cleaned.length > 0 ? cleaned : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LettaOAuthError('cancelled', 'OAuth request cancelled');
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only.
  }
}

// Parse a JSON response without ever surfacing body contents in errors.
async function parseJsonResponse(
  response: Response,
  action: string,
  signal?: AbortSignal
): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0];
  if (
    contentType &&
    contentType !== 'application/json' &&
    !contentType.endsWith('+json')
  ) {
    await cancelBody(response);
    throw new LettaOAuthError(
      'malformed-response',
      `${action}: received non-JSON response (HTTP ${response.status})`
    );
  }

  try {
    return await response.json();
  } catch (error) {
    if (isAbortLike(error)) {
      throwIfAborted(signal);
      throw new LettaOAuthError('cancelled', 'OAuth request cancelled');
    }
    throw new LettaOAuthError(
      'malformed-response',
      `${action}: received malformed JSON (HTTP ${response.status})`
    );
  }
}

type OAuthErrorPayload = {
  error?: unknown;
};

function oauthErrorCode(payload: unknown): string | undefined {
  return sanitizeDescription((payload as OAuthErrorPayload)?.error);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LettaOAuthError('cancelled', 'OAuth polling cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new LettaOAuthError('cancelled', 'OAuth polling cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toTransportError(action: string, error: unknown): LettaOAuthError {
  if (error instanceof LettaOAuthError) {
    return error;
  }
  if (isAbortLike(error)) {
    return new LettaOAuthError('cancelled', 'OAuth request cancelled');
  }
  return new LettaOAuthError(
    'transient',
    `${action}: could not reach ${LETTA_OAUTH_AUTH_BASE_URL}`
  );
}

// Step 1: request a device code and user code.
export async function requestDeviceCode(
  options: OAuthRequestOptions = {}
): Promise<DeviceCodeResponse> {
  const doFetch = getFetch(options);

  for (
    let attempt = 1;
    attempt <= DEVICE_CODE_REQUEST_MAX_ATTEMPTS;
    attempt += 1
  ) {
    throwIfAborted(options.signal);
    let response: Response;
    try {
      // Bounded sequential retries are intentional.
      // oxlint-disable-next-line no-await-in-loop
      response = await doFetch(
        `${LETTA_OAUTH_AUTH_BASE_URL}${DEVICE_CODE_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: LETTA_OAUTH_CLIENT_ID }),
          signal: options.signal,
        }
      );
    } catch (error) {
      if (isAbortLike(error)) {
        throw new LettaOAuthError('cancelled', 'OAuth request cancelled');
      }
      // Transport failures are worth one bounded retry; DNS or TLS hiccups are
      // common at first launch while the network stack settles.
      if (attempt < DEVICE_CODE_REQUEST_MAX_ATTEMPTS) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(DEVICE_CODE_RETRY_DELAY_MS * attempt, options.signal);
        continue;
      }
      throw new LettaOAuthError(
        'transient',
        `Could not start sign in: failed to reach ${LETTA_OAUTH_AUTH_BASE_URL}`
      );
    }

    let payload: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop
      payload = await parseJsonResponse(
        response,
        'Device code request',
        options.signal
      );
    } catch (error) {
      const oauthError = toTransportError('Device code request', error);
      if (oauthError.kind === 'cancelled') {
        throw oauthError;
      }
      const shouldRetry =
        oauthError.kind === 'transient' ||
        (oauthError.kind === 'malformed-response' &&
          isTransientStatus(response.status));
      if (shouldRetry && attempt < DEVICE_CODE_REQUEST_MAX_ATTEMPTS) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(DEVICE_CODE_RETRY_DELAY_MS * attempt, options.signal);
        continue;
      }
      throw oauthError;
    }

    if (!response.ok) {
      if (isTransientStatus(response.status)) {
        if (attempt < DEVICE_CODE_REQUEST_MAX_ATTEMPTS) {
          // oxlint-disable-next-line no-await-in-loop
          await sleep(DEVICE_CODE_RETRY_DELAY_MS * attempt, options.signal);
          continue;
        }
        throw new LettaOAuthError(
          'transient',
          `Could not start sign in (HTTP ${response.status})`
        );
      }
      throw new LettaOAuthError(
        'request-failed',
        `Could not start sign in (HTTP ${response.status})`
      );
    }

    const candidate = payload as Partial<DeviceCodeResponse>;
    if (
      typeof candidate.device_code !== 'string' ||
      !candidate.device_code ||
      typeof candidate.user_code !== 'string' ||
      !candidate.user_code ||
      typeof candidate.verification_uri !== 'string' ||
      !candidate.verification_uri.startsWith('https://')
    ) {
      throw new LettaOAuthError(
        'malformed-response',
        'Device code response was missing required fields'
      );
    }

    return {
      device_code: candidate.device_code,
      user_code: candidate.user_code,
      verification_uri: candidate.verification_uri,
      verification_uri_complete:
        typeof candidate.verification_uri_complete === 'string' &&
        candidate.verification_uri_complete.startsWith('https://')
          ? candidate.verification_uri_complete
          : candidate.verification_uri,
      expires_in:
        typeof candidate.expires_in === 'number' && candidate.expires_in > 0
          ? candidate.expires_in
          : 900,
      interval:
        typeof candidate.interval === 'number' && candidate.interval > 0
          ? candidate.interval
          : 5,
    };
  }

  throw new LettaOAuthError(
    'transient',
    'Could not start sign in: retries exhausted'
  );
}

function isValidTokenResponse(value: unknown): value is TokenResponse {
  const candidate = value as Partial<TokenResponse>;
  return (
    typeof candidate.access_token === 'string' &&
    candidate.access_token.length > 0 &&
    typeof candidate.token_type === 'string' &&
    typeof candidate.expires_in === 'number' &&
    Number.isFinite(candidate.expires_in) &&
    candidate.expires_in > 0
  );
}

// Step 2: poll the token endpoint until the user approves, denies, or the
// device code expires. Honors the server-provided interval and slow_down.
export async function pollForToken(
  deviceCode: string,
  options: {
    deviceId: string;
    deviceName?: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    fetch?: FetchLike;
    signal?: AbortSignal;
  }
): Promise<TokenResponse> {
  const doFetch = options.fetch ?? fetch;
  const signal = options.signal;
  const startedAt = Date.now();
  const deadlineMs =
    startedAt + Math.max(0, options.expiresInSeconds ?? 900) * 1000;
  let pollIntervalMs = Math.max(0, options.intervalSeconds ?? 5) * 1000;
  let transientFailures = 0;

  while (Date.now() < deadlineMs) {
    // Polling waits between requests by design.
    // oxlint-disable-next-line no-await-in-loop
    await sleep(pollIntervalMs, signal);

    let response: Response;
    let payload: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop
      response = await doFetch(`${LETTA_OAUTH_AUTH_BASE_URL}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: LETTA_OAUTH_CLIENT_ID,
          device_code: deviceCode,
          device_id: options.deviceId,
          ...(options.deviceName ? { device_name: options.deviceName } : {}),
        }),
        signal,
      });
      // oxlint-disable-next-line no-await-in-loop
      payload = await parseJsonResponse(response, 'Token poll', signal);
    } catch (error) {
      const oauthError = toTransportError('Token poll', error);
      if (oauthError.kind === 'cancelled') {
        throw oauthError;
      }
      // Transient poll failures stay inside the normal polling loop until the
      // failure budget runs out, then surface as a recoverable error.
      transientFailures += 1;
      if (transientFailures > TOKEN_POLL_TRANSIENT_FAILURE_LIMIT) {
        throw oauthError;
      }
      continue;
    }

    if (response.ok) {
      if (!isValidTokenResponse(payload)) {
        throw new LettaOAuthError(
          'malformed-response',
          'Token response was missing required fields'
        );
      }
      return payload;
    }

    const code = oauthErrorCode(payload);
    if (code === 'authorization_pending') {
      transientFailures = 0;
      continue;
    }
    if (code === 'slow_down') {
      transientFailures = 0;
      pollIntervalMs += SLOW_DOWN_EXTRA_MS;
      continue;
    }
    if (code === 'access_denied') {
      throw new LettaOAuthError('denied', 'Authorization was denied');
    }
    if (code === 'expired_token') {
      throw new LettaOAuthError('expired', 'Sign-in code expired');
    }
    if (isTransientStatus(response.status)) {
      transientFailures += 1;
      if (transientFailures > TOKEN_POLL_TRANSIENT_FAILURE_LIMIT) {
        throw new LettaOAuthError(
          'transient',
          `Sign in interrupted (HTTP ${response.status})`
        );
      }
      continue;
    }

    throw new LettaOAuthError(
      'request-failed',
      `Sign in failed (HTTP ${response.status})`
    );
  }

  throw new LettaOAuthError('expired', 'Sign-in window closed before approval');
}

// Exchange a refresh token for a rotated token pair.
export async function refreshAccessToken(
  refreshToken: string,
  options: {
    deviceId: string;
    deviceName?: string;
    fetch?: FetchLike;
  }
): Promise<TokenResponse> {
  const doFetch = options.fetch ?? fetch;

  let response: Response;
  let payload: unknown;
  try {
    response = await doFetch(`${LETTA_OAUTH_AUTH_BASE_URL}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: LETTA_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
        refresh_token_mode: 'new',
        device_id: options.deviceId,
        ...(options.deviceName ? { device_name: options.deviceName } : {}),
      }),
    });
    payload = await parseJsonResponse(response, 'Token refresh');
  } catch (error) {
    throw toTransportError('Token refresh', error);
  }

  if (!response.ok) {
    const code = oauthErrorCode(payload);
    if (code === 'invalid_grant') {
      throw new LettaOAuthError(
        'invalid-grant',
        'Stored sign in is no longer valid'
      );
    }
    if (isTransientStatus(response.status)) {
      throw new LettaOAuthError(
        'transient',
        `Token refresh failed (HTTP ${response.status})`
      );
    }
    throw new LettaOAuthError(
      'request-failed',
      `Token refresh failed (HTTP ${response.status})`
    );
  }

  if (!isValidTokenResponse(payload)) {
    throw new LettaOAuthError(
      'malformed-response',
      'Refresh response was missing required fields'
    );
  }
  return payload;
}

// Revoke a refresh token. Best effort by design: local credentials are always
// cleared afterwards regardless of the server result.
export async function revokeToken(
  refreshToken: string,
  options: { fetch?: FetchLike } = {}
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(
      `${LETTA_OAUTH_AUTH_BASE_URL}${REVOKE_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: LETTA_OAUTH_CLIENT_ID,
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }),
      }
    );
    await cancelBody(response);
  } catch {
    // Never fail logout over a revocation error.
  }
}

// Check an access token against an authenticated API endpoint before trusting it.
export async function validateAccessToken(
  accessToken: string,
  options: { fetch?: FetchLike } = {}
): Promise<LettaTokenValidation> {
  const doFetch = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${LETTA_OAUTH_API_BASE_URL}/v1/agents?limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, reason: 'transient' };
  }

  if (response.ok) {
    await cancelBody(response);
    return { ok: true };
  }
  await cancelBody(response);
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: false, reason: 'transient' };
}
