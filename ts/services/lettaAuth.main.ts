// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Main-process Letta authentication service.
//
// Owns the OAuth device flow, encrypted credential storage, refresh
// scheduling, and logout. Credentials never leave this process except through
// the narrow 'letta-auth:get-credential' channel used by the preload Letta
// service; renderer-facing status is always sanitized.

import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain as ipc, safeStorage, shell } from 'electron';

import { userConfig } from '../../app/user_config.main.ts';
import { createLogger } from '../logging/log.std.ts';
import type {
  LettaAuthErrorCode,
  LettaAuthStatus,
  LettaCredentialCheck,
} from '../types/LettaAuth.std.ts';
import { getLettaAuthTimerSegment } from '../util/lettaAuthTimer.std.ts';
import { LETTA_API_KEY, LETTA_MODE } from '../util/lettaMode.std.ts';
import {
  LETTA_OAUTH_AUTH_BASE_URL,
  LettaOAuthError,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  revokeToken,
  validateAccessToken,
} from './lettaOAuthProvider.std.ts';

const log = createLogger('lettaAuth');

const CONFIG_KEY = 'lettaAuth';
const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_RETRY_DELAY_MS = 30_000;
const REFRESH_MAX_ATTEMPTS = 3;

type StoredRecord = Readonly<{
  deviceId?: string;
  // Hex-encoded safeStorage ciphertext of the JSON credentials blob.
  encryptedCredentials?: string;
  safeStorageBackend?: string;
}>;

type StoredCredentials = Readonly<{
  accessToken: string;
  refreshToken?: string;
  // Epoch milliseconds.
  expiresAt: number;
}>;

export type LettaCredential =
  | { source: 'environment'; apiKey: string }
  | { source: 'oauth'; apiKey: string };

function currentSafeStorageBackend(): string | undefined {
  return process.platform === 'linux'
    ? safeStorage.getSelectedStorageBackend()
    : undefined;
}

function secureStorageAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    currentSafeStorageBackend() !== 'basic_text'
  );
}

function readRecord(): StoredRecord {
  const value = userConfig.get(CONFIG_KEY);
  if (!value || typeof value !== 'object') {
    return {};
  }
  const candidate = value as Partial<StoredRecord>;
  return {
    deviceId:
      typeof candidate.deviceId === 'string' && candidate.deviceId
        ? candidate.deviceId
        : undefined,
    encryptedCredentials:
      typeof candidate.encryptedCredentials === 'string' &&
      candidate.encryptedCredentials
        ? candidate.encryptedCredentials
        : undefined,
    safeStorageBackend:
      typeof candidate.safeStorageBackend === 'string'
        ? candidate.safeStorageBackend
        : undefined,
  };
}

function writeRecord(record: StoredRecord): void {
  userConfig.set(CONFIG_KEY, record);
}

function clearRecord(): void {
  userConfig.set(CONFIG_KEY, undefined);
}

function clearStoredCredentials(record: StoredRecord = readRecord()): void {
  // The installation device ID is not a credential. Keep it stable across
  // logout and unreadable-token recovery while removing all encrypted secrets
  // and storage-backend metadata.
  if (record.deviceId) {
    writeRecord({ deviceId: record.deviceId });
  } else {
    clearRecord();
  }
}

function deviceName(): string {
  let platform = 'Linux';
  if (process.platform === 'darwin') {
    platform = 'macOS';
  } else if (process.platform === 'win32') {
    platform = 'Windows';
  }
  return `Signal Letta on ${platform}`;
}

// Module state ---------------------------------------------------------------

let status: LettaAuthStatus = {
  state: 'signed-out',
  secureStorageAvailable: false,
};
let credentials: StoredCredentials | undefined;
// Incremented whenever the active credential record changes so late refresh
// responses cannot sign the user back in after logout or overwrite a newer login.
let credentialVersion = 0;
let loginAbortController: AbortController | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let refreshPromise: Promise<void> | undefined;
let loginPromise: Promise<void> | undefined;
let loginStartPromise: Promise<LettaAuthStatus> | undefined;

// Status plumbing ------------------------------------------------------------

function setStatus(next: LettaAuthStatus): void {
  status = next;
  broadcastStatus();
}

function broadcastStatus(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send('letta-auth:status-changed', status);
  }
}

function signedOutStatus(): LettaAuthStatus {
  return {
    state: 'signed-out',
    secureStorageAvailable: secureStorageAvailable(),
  };
}

function errorStatus(
  code: LettaAuthErrorCode,
  message: string,
  recoverable: boolean
): LettaAuthStatus {
  return { state: 'error', code, message, recoverable };
}

// Credential storage ---------------------------------------------------------

function decryptStoredCredentials(
  record: StoredRecord
): StoredCredentials | undefined {
  if (!record.encryptedCredentials) {
    return undefined;
  }
  if (
    !secureStorageAvailable() ||
    (record.safeStorageBackend &&
      record.safeStorageBackend !== currentSafeStorageBackend())
  ) {
    log.warn('stored Letta credentials unreadable: secure storage changed');
    clearStoredCredentials(record);
    return undefined;
  }
  try {
    const json = safeStorage.decryptString(
      Buffer.from(record.encryptedCredentials, 'hex')
    );
    const parsed = JSON.parse(json) as Partial<StoredCredentials>;
    if (
      typeof parsed.accessToken !== 'string' ||
      !parsed.accessToken ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= 0
    ) {
      throw new Error('malformed credentials payload');
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken:
        typeof parsed.refreshToken === 'string' && parsed.refreshToken
          ? parsed.refreshToken
          : undefined,
      expiresAt: parsed.expiresAt,
    };
  } catch (error) {
    log.warn('stored Letta credentials could not be decrypted', {
      error: error instanceof Error ? error.message : String(error),
    });
    clearStoredCredentials(record);
    return undefined;
  }
}

function persistCredentials(next: StoredCredentials): void {
  const record = readRecord();
  const deviceId = record.deviceId ?? randomUUID();
  const encrypted = safeStorage
    .encryptString(JSON.stringify(next))
    .toString('hex');
  writeRecord({
    deviceId,
    encryptedCredentials: encrypted,
    safeStorageBackend: currentSafeStorageBackend(),
  });
  credentials = next;
  credentialVersion += 1;
}

function getDeviceId(): string {
  const record = readRecord();
  if (record.deviceId) {
    return record.deviceId;
  }
  const deviceId = randomUUID();
  writeRecord({ ...record, deviceId });
  return deviceId;
}

function clearCredentials(): void {
  credentials = undefined;
  credentialVersion += 1;
  stopRefreshTimer();
  clearStoredCredentials();
}

// Refresh scheduling ----------------------------------------------------------

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefresh(delayOverrideMs?: number): void {
  stopRefreshTimer();
  if (!credentials?.refreshToken) {
    return;
  }
  const targetDelayMs =
    delayOverrideMs ??
    Math.max(0, credentials.expiresAt - REFRESH_MARGIN_MS - Date.now());
  const { delayMs, needsReschedule } = getLettaAuthTimerSegment(targetDelayMs);
  refreshTimer = setTimeout(() => {
    if (needsReschedule) {
      // The target is beyond Node's timer range. Recalculate the remaining
      // duration instead of refreshing early.
      scheduleRefresh();
      return;
    }
    void beginRefresh();
  }, delayMs);
  refreshTimer.unref?.();
}

async function doRefresh(): Promise<void> {
  const current = credentials;
  const startingVersion = credentialVersion;
  if (!current?.refreshToken) {
    return;
  }
  const isCurrentCredential = () =>
    credentials === current && credentialVersion === startingVersion;

  setStatus({ state: 'refreshing', source: 'oauth' });

  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
    if (!isCurrentCredential()) {
      return;
    }
    try {
      // Sequential retry attempts are intentional.
      // oxlint-disable-next-line no-await-in-loop
      const next = await refreshAccessToken(current.refreshToken, {
        deviceId: getDeviceId(),
        deviceName: deviceName(),
      });
      if (!isCurrentCredential()) {
        // Logout or a newer login won the race while the request was in flight.
        // A rotating server may have invalidated the old token already, so
        // revoke the newly returned refresh token rather than restoring it.
        if (next.refresh_token) {
          // oxlint-disable-next-line no-await-in-loop
          await revokeToken(next.refresh_token);
        }
        return;
      }
      const rotated: StoredCredentials = {
        accessToken: next.access_token,
        refreshToken: next.refresh_token ?? current.refreshToken,
        expiresAt: Date.now() + next.expires_in * 1000,
      };
      persistCredentials(rotated);
      setStatus({ state: 'signed-in', source: 'oauth' });
      scheduleRefresh();
      log.info('Letta access token refreshed');
      return;
    } catch (error) {
      if (!isCurrentCredential()) {
        return;
      }
      if (error instanceof LettaOAuthError && error.kind === 'invalid-grant') {
        log.warn('Letta refresh token was rejected; signing out');
        clearCredentials();
        setStatus(signedOutStatus());
        return;
      }
      const retryable =
        error instanceof LettaOAuthError && error.kind === 'transient';
      if (!retryable || attempt === REFRESH_MAX_ATTEMPTS) {
        log.error('Letta token refresh failed', {
          attempt,
          kind: error instanceof LettaOAuthError ? error.kind : 'unknown',
        });
        // Keep the old tokens; they may still be valid. Surface signed-in so
        // the app keeps working until a request actually fails. Use an explicit
        // retry delay: normal scheduling would compute zero once the refresh
        // margin has passed and create a tight refresh loop.
        setStatus({ state: 'signed-in', source: 'oauth' });
        scheduleRefresh(REFRESH_RETRY_DELAY_MS * REFRESH_MAX_ATTEMPTS);
        return;
      }
      // Backoff between retry attempts is intentional.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise(resolve =>
        setTimeout(resolve, REFRESH_RETRY_DELAY_MS * attempt)
      );
    }
  }
}

async function beginRefresh(): Promise<void> {
  if (refreshPromise) {
    await refreshPromise;
    return;
  }
  const pending = doRefresh();
  refreshPromise = pending;
  try {
    await pending;
  } finally {
    if (refreshPromise === pending) {
      refreshPromise = undefined;
    }
  }
}

async function ensureFreshToken(): Promise<void> {
  if (!credentials?.refreshToken) {
    return;
  }
  if (Date.now() < credentials.expiresAt - REFRESH_MARGIN_MS) {
    return;
  }
  void beginRefresh();
  await refreshPromise;
}

// Login flow ------------------------------------------------------------------

async function openVerificationUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.host !== new URL(LETTA_OAUTH_AUTH_BASE_URL).host
    ) {
      log.error('refusing to open unexpected verification URL host');
      return false;
    }
  } catch {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    log.error('failed to open verification URL', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function startLogin(): Promise<LettaAuthStatus> {
  if (LETTA_API_KEY) {
    return { state: 'signed-in', source: 'environment' };
  }
  if (status.state === 'signed-in' || status.state === 'refreshing') {
    return status;
  }
  if (status.state === 'authorizing') {
    return status;
  }
  if (!secureStorageAvailable()) {
    setStatus(
      errorStatus(
        'secure-storage-unavailable',
        'Secure credential storage is unavailable on this system.',
        true
      )
    );
    return status;
  }

  let deviceCode;
  try {
    deviceCode = await requestDeviceCode();
  } catch (error) {
    const kind = error instanceof LettaOAuthError ? error.kind : 'unknown';
    log.warn('device code request failed', { kind });
    setStatus(
      kind === 'transient'
        ? errorStatus(
            'network-error',
            'Could not reach Letta. Check your connection and try again.',
            true
          )
        : errorStatus(
            'device-code-request-failed',
            'Could not start sign in. Try again.',
            true
          )
    );
    return status;
  }

  const controller = new AbortController();
  loginAbortController?.abort();
  loginAbortController = controller;

  setStatus({
    state: 'authorizing',
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri,
    verificationUriComplete: deviceCode.verification_uri_complete,
    expiresAt: Date.now() + deviceCode.expires_in * 1000,
  });

  // Fire and forget: the login flow continues while the browser opens.
  void openVerificationUrl(deviceCode.verification_uri_complete);

  const pending = completeAuthorizingLogin(
    deviceCode.device_code,
    deviceCode.expires_in,
    deviceCode.interval,
    controller
  );
  loginPromise = pending;
  void (async () => {
    try {
      await pending;
    } finally {
      if (loginPromise === pending) {
        loginPromise = undefined;
      }
    }
  })();
  return status;
}

async function completeAuthorizingLogin(
  deviceCode: string,
  expiresInSeconds: number,
  intervalSeconds: number | undefined,
  controller: AbortController
): Promise<void> {
  const isCurrentLogin = () =>
    loginAbortController === controller && !controller.signal.aborted;

  let tokens;
  try {
    tokens = await pollForToken(deviceCode, {
      deviceId: getDeviceId(),
      deviceName: deviceName(),
      intervalSeconds,
      expiresInSeconds,
      signal: controller.signal,
    });
  } catch (error) {
    const wasCurrent = loginAbortController === controller;
    if (wasCurrent) {
      loginAbortController = undefined;
    }
    if (!wasCurrent || controller.signal.aborted) {
      return;
    }
    if (error instanceof LettaOAuthError && error.kind !== 'cancelled') {
      const mapping: Record<
        string,
        { code: LettaAuthErrorCode; message: string; recoverable: boolean }
      > = {
        denied: {
          code: 'authorization-denied',
          message: 'Authorization was denied in the browser.',
          recoverable: true,
        },
        expired: {
          code: 'authorization-expired',
          message: 'The sign-in window closed before you approved.',
          recoverable: true,
        },
        transient: {
          code: 'network-error',
          message: 'Lost contact with Letta during sign in. Try again.',
          recoverable: true,
        },
      };
      const mapped =
        mapping[error.kind] ??
        ({
          code: 'device-code-request-failed',
          message: 'Sign in did not complete. Try again.',
          recoverable: true,
        } as const);
      setStatus(errorStatus(mapped.code, mapped.message, mapped.recoverable));
    } else {
      setStatus(signedOutStatus());
    }
    return;
  }

  // Only trust and persist the new session after the API accepts it. Cancellation
  // can race with validation, so re-check ownership after every await and revoke
  // any token pair that the user chose not to keep.
  const validation = await validateAccessToken(tokens.access_token);
  if (!isCurrentLogin()) {
    if (tokens.refresh_token) {
      await revokeToken(tokens.refresh_token);
    }
    return;
  }
  if (!validation.ok) {
    if (tokens.refresh_token) {
      await revokeToken(tokens.refresh_token);
    }
    if (!isCurrentLogin()) {
      return;
    }
    loginAbortController = undefined;
    if (validation.reason === 'invalid') {
      setStatus(
        errorStatus(
          'validation-failed',
          'Letta did not accept the new sign in. Try again.',
          true
        )
      );
    } else {
      setStatus(
        errorStatus(
          'network-error',
          'Could not confirm the new sign in with Letta. Try again.',
          true
        )
      );
    }
    return;
  }

  try {
    persistCredentials({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
  } catch (error) {
    log.error('failed to store Letta OAuth credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (tokens.refresh_token) {
      await revokeToken(tokens.refresh_token);
    }
    if (isCurrentLogin()) {
      loginAbortController = undefined;
      setStatus(
        errorStatus(
          'secure-storage-unavailable',
          'Could not store the Letta sign in securely. Try again.',
          true
        )
      );
    }
    return;
  }

  loginAbortController = undefined;
  setStatus({ state: 'signed-in', source: 'oauth' });
  scheduleRefresh();
  log.info('Letta OAuth login complete');
}

async function beginLogin(): Promise<LettaAuthStatus> {
  if (
    status.state === 'signed-in' ||
    status.state === 'refreshing' ||
    status.state === 'authorizing'
  ) {
    return status;
  }
  if (loginStartPromise) {
    return loginStartPromise;
  }
  const pending = startLogin();
  loginStartPromise = pending;
  try {
    return await pending;
  } finally {
    if (loginStartPromise === pending) {
      loginStartPromise = undefined;
    }
  }
}

function cancelLogin(): LettaAuthStatus {
  loginAbortController?.abort();
  loginAbortController = undefined;
  loginStartPromise = undefined;
  if (status.state === 'authorizing') {
    setStatus(signedOutStatus());
  }
  return status;
}

async function logout(): Promise<LettaAuthStatus> {
  if (LETTA_API_KEY) {
    return { state: 'signed-in', source: 'environment' };
  }
  loginAbortController?.abort();
  loginAbortController = undefined;
  loginStartPromise = undefined;

  const refreshToken = credentials?.refreshToken;
  clearCredentials();
  if (refreshToken) {
    await revokeToken(refreshToken);
  }
  setStatus(signedOutStatus());
  log.info('Letta logout complete');
  return status;
}

// Startup ---------------------------------------------------------------------

function initializeAuthState(): void {
  if (LETTA_API_KEY) {
    credentials = undefined;
    setStatus({ state: 'signed-in', source: 'environment' });
    return;
  }

  const record = readRecord();
  const stored = decryptStoredCredentials(record);
  if (!stored) {
    setStatus(signedOutStatus());
    return;
  }

  credentials = stored;
  setStatus({ state: 'signed-in', source: 'oauth' });
  if (stored.refreshToken) {
    if (Date.now() >= stored.expiresAt - REFRESH_MARGIN_MS) {
      void beginRefresh();
    } else {
      scheduleRefresh();
    }
  }
}

// Credential lookup for the preload-only Letta service ------------------------

async function getCredential(): Promise<LettaCredential | undefined> {
  if (LETTA_API_KEY) {
    return { source: 'environment', apiKey: LETTA_API_KEY };
  }
  if (!credentials) {
    return undefined;
  }
  await ensureFreshToken();
  if (!credentials) {
    return undefined;
  }
  return { source: 'oauth', apiKey: credentials.accessToken };
}

async function checkCredential(): Promise<LettaCredentialCheck> {
  const cred = await getCredential();
  if (!cred) {
    return { state: 'signed-out' };
  }
  const result = await validateAccessToken(cred.apiKey);
  if (result.ok) {
    return { state: 'ok' };
  }
  return { state: result.reason === 'invalid' ? 'invalid' : 'unreachable' };
}

function getStatus(): LettaAuthStatus {
  return status;
}

// Re-open the authorization page for an in-progress sign in. The URL is
// validated before it is opened.
async function openAuthorization(rawUrl: unknown): Promise<void> {
  if (typeof rawUrl !== 'string' || status.state !== 'authorizing') {
    return;
  }
  const matchesCurrent =
    rawUrl === status.verificationUriComplete ||
    rawUrl === status.verificationUri;
  if (!matchesCurrent) {
    log.warn('refused to open authorization URL');
    return;
  }
  await openVerificationUrl(rawUrl);
}

// Installation ----------------------------------------------------------------

let installed = false;

export function installLettaAuthService(): void {
  if (!LETTA_MODE || installed) {
    return;
  }
  installed = true;

  status = {
    state: 'signed-out',
    secureStorageAvailable: secureStorageAvailable(),
  };
  initializeAuthState();

  ipc.handle('letta-auth:get-status', () => getStatus());
  ipc.handle('letta-auth:get-credential', () => getCredential());
  ipc.handle('letta-auth:check-credential', () => checkCredential());
  ipc.handle('letta-auth:start-login', () => beginLogin());
  ipc.handle('letta-auth:cancel-login', () => cancelLogin());
  ipc.handle('letta-auth:logout', () => logout());
  ipc.handle('letta-auth:open-authorization', (_event, url) =>
    openAuthorization(url)
  );

  // Keep late-loading windows in sync.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('letta-auth:status-changed', status);
    }
  }

  log.info('Letta auth service installed');
}
