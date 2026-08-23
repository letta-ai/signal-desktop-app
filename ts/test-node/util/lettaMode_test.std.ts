// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { lettaApiKeyFromEnvironment } from '../../util/lettaMode.std.ts';

describe('Letta environment credentials', () => {
  it('uses LETTA_API_KEY when set', () => {
    assert.equal(
      lettaApiKeyFromEnvironment({ LETTA_API_KEY: 'sk-let-abc' }),
      'sk-let-abc'
    );
  });

  it('trims surrounding whitespace', () => {
    assert.equal(
      lettaApiKeyFromEnvironment({ LETTA_API_KEY: '  sk-let-abc  ' }),
      'sk-let-abc'
    );
  });

  it('treats empty and whitespace-only values as unset', () => {
    assert.isUndefined(lettaApiKeyFromEnvironment({ LETTA_API_KEY: '' }));
    assert.isUndefined(lettaApiKeyFromEnvironment({ LETTA_API_KEY: '   ' }));
  });

  it('no longer recognizes removed credential aliases', () => {
    assert.isUndefined(
      lettaApiKeyFromEnvironment({ DEVELOPERS_API_KEY: 'sk-let-dev' })
    );
    assert.isUndefined(
      lettaApiKeyFromEnvironment({ COMPANY_LETTA_API_KEY: 'sk-let-co' })
    );
    assert.isUndefined(
      lettaApiKeyFromEnvironment({ LETTA_RUNTIME_API_KEY: 'sk-let-rt' })
    );
  });

  it('ignores aliases even when combined with the canonical key', () => {
    assert.equal(
      lettaApiKeyFromEnvironment({
        LETTA_API_KEY: 'sk-let-canonical',
        DEVELOPERS_API_KEY: 'sk-let-dev',
      }),
      'sk-let-canonical'
    );
  });
});
