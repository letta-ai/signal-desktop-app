// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { isLettaAuthStatus } from '../../types/LettaAuth.std.ts';

describe('Letta auth status validation', () => {
  it('accepts sanitized signed-in and authorizing states', () => {
    assert.isTrue(isLettaAuthStatus({ state: 'signed-in', source: 'oauth' }));
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
});
