// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Renderer-facing Letta authentication state. This file must never contain
// access tokens, refresh tokens, or any other secret material. The main
// process keeps credentials encrypted and only reports sanitized status.

export type LettaAuthErrorCode =
  | 'secure-storage-unavailable'
  | 'device-code-request-failed'
  | 'authorization-expired'
  | 'authorization-denied'
  | 'network-error'
  | 'refresh-revoked'
  | 'validation-failed';

export type LettaAuthStatus =
  | { state: 'signed-out'; secureStorageAvailable: boolean }
  | {
      state: 'authorizing';
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresAt: number;
    }
  | { state: 'signed-in'; source: 'environment' | 'oauth' }
  | { state: 'refreshing'; source: 'oauth' }
  | {
      state: 'error';
      code: LettaAuthErrorCode;
      message: string;
      recoverable: boolean;
    };

function isLettaAuthErrorCode(value: unknown): value is LettaAuthErrorCode {
  return (
    value === 'secure-storage-unavailable' ||
    value === 'device-code-request-failed' ||
    value === 'authorization-expired' ||
    value === 'authorization-denied' ||
    value === 'network-error' ||
    value === 'refresh-revoked' ||
    value === 'validation-failed'
  );
}

export function isLettaAuthStatus(value: unknown): value is LettaAuthStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  switch (candidate.state) {
    case 'signed-out':
      return typeof candidate.secureStorageAvailable === 'boolean';
    case 'authorizing':
      return (
        typeof candidate.userCode === 'string' &&
        typeof candidate.verificationUri === 'string' &&
        typeof candidate.verificationUriComplete === 'string' &&
        typeof candidate.expiresAt === 'number'
      );
    case 'signed-in':
      return candidate.source === 'environment' || candidate.source === 'oauth';
    case 'refreshing':
      return candidate.source === 'oauth';
    case 'error':
      return (
        isLettaAuthErrorCode(candidate.code) &&
        typeof candidate.message === 'string' &&
        typeof candidate.recoverable === 'boolean'
      );
    default:
      return false;
  }
}
