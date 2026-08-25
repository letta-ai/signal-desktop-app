// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import { assert } from 'chai';

import {
  baseAgentName,
  isForeignLettaChat,
  isMissingAgent,
  isMissingLettaConversation,
  isUnauthorized,
} from '../../util/lettaSendErrors.std.ts';

describe('lettaSendErrors', () => {
  it('detects a missing Letta conversation', () => {
    assert.isTrue(
      isMissingLettaConversation(new Error('404 Conversation not found'))
    );
    assert.isFalse(isMissingLettaConversation(new Error('401 Unauthorized')));
  });

  it('detects a missing Letta agent without matching conversations', () => {
    assert.isTrue(
      isMissingAgent(
        new Error(
          '500 {"error":"Agent agent-11111111-1111-1111-1111-111111111111 not found"}'
        )
      )
    );
    assert.isTrue(isMissingAgent(new Error('404 Agent not found')));
    assert.isFalse(isMissingAgent(new Error('404 Conversation not found')));
  });

  it('strips duplicate-name suffixes from cached contact names', () => {
    assert.equal(baseAgentName('Overlord (a1b2c3)'), 'Overlord');
    assert.equal(baseAgentName('Overlord'), 'Overlord');
  });

  it('treats 401 as a foreign chat when the agent directory already loaded', () => {
    const error = new Error('401 Unauthorized');
    assert.isTrue(isUnauthorized(error));
    assert.isTrue(isForeignLettaChat(error, true));
    assert.isFalse(isForeignLettaChat(error, false));
    assert.isFalse(isForeignLettaChat(new Error('404 Agent not found'), true));
  });
});
