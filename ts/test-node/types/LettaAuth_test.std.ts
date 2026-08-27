// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  isLettaAuthStatus,
  isLettaCredentialCheck,
  readLettaAuthStatus,
} from '../../types/LettaAuth.std.ts';

describe('Letta auth status validation', () => {
  it('accepts sanitized signed-in and authorizing states', () => {
    assert.isTrue(isLettaAuthStatus({ state: 'signed-in', source: 'oauth' }));
    assert.isTrue(
      isLettaAuthStatus({
        state: 'signed-out',
        secureStorageAvailable: true,
      })
    );
    assert.isTrue(
      isLettaAuthStatus({
        state: 'authorizing',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://app.letta.com/oauth/device',
        verificationUriComplete:
          'https://app.letta.com/oauth/device?user_code=ABCD-EFGH',
        expiresAt: Date.now() + 60_000,
      })
    );
  });

  it('rejects unknown and incomplete states', () => {
    assert.isFalse(isLettaAuthStatus({ state: 'signed-in', source: 'other' }));
    assert.isFalse(isLettaAuthStatus({ state: 'authorizing' }));
    assert.isFalse(isLettaAuthStatus({ state: 'arbitrary' }));
  });

  it('rejects error payloads with unknown codes or missing fields', () => {
    assert.isFalse(
      isLettaAuthStatus({
        state: 'error',
        code: 'server-body',
        message: 'bad',
        recoverable: true,
      })
    );
    assert.isFalse(
      isLettaAuthStatus({
        state: 'error',
        code: 'network-error',
        message: 'offline',
      })
    );
  });

  it('reads auth status from Whisper or IPC argument shapes', () => {
    const signedOut = {
      state: 'signed-out' as const,
      secureStorageAvailable: true,
    };
    assert.deepEqual(readLettaAuthStatus(signedOut), signedOut);
    assert.deepEqual(
      readLettaAuthStatus({ type: 'event' }, signedOut),
      signedOut
    );
    assert.isUndefined(readLettaAuthStatus({ type: 'event' }));
  });
});

describe('Letta credential check validation', () => {
  it('accepts known check states', () => {
    assert.isTrue(isLettaCredentialCheck({ state: 'ok' }));
    assert.isTrue(isLettaCredentialCheck({ state: 'invalid' }));
    assert.isTrue(isLettaCredentialCheck({ state: 'unreachable' }));
    assert.isTrue(isLettaCredentialCheck({ state: 'signed-out' }));
  });

  it('rejects unknown check states', () => {
    assert.isFalse(isLettaCredentialCheck({ state: 'signed-in' }));
    assert.isFalse(isLettaCredentialCheck({}));
  });
});
