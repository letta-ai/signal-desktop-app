// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import { assert } from 'chai';

import {
  formatLettaQuotedSend,
  formatLettaReactionSend,
  formatLettaToolStatus,
  formatLettaWorkingLine,
} from '../../util/lettaThinking.std.ts';

describe('lettaThinking', () => {
  it('uses a thinking verb when no tool is in flight', () => {
    assert.equal(
      formatLettaWorkingLine('Pete', undefined, 'metacognating'),
      'Pete is metacognating'
    );
  });

  it('prefers a tool description over the tool name', () => {
    assert.equal(
      formatLettaWorkingLine(
        'Pete',
        {
          toolName: 'Bash',
          toolInput: { description: 'Check git status' },
        },
        'thinking'
      ),
      'Pete is check git status'
    );
    assert.equal(
      formatLettaToolStatus({
        toolName: 'Bash',
        toolInput: { description: 'Check git status' },
      }),
      'Check git status'
    );
  });

  it('falls back to the tool name', () => {
    assert.equal(
      formatLettaWorkingLine(
        'Pete',
        { toolName: 'web_search', toolInput: {} },
        'thinking'
      ),
      'Pete is using web_search'
    );
  });

  it('formats quoted replies and reactions for the agent', () => {
    assert.equal(
      formatLettaQuotedSend('Try this', 'earlier answer'),
      'Replying to: "earlier answer"\n\nTry this'
    );
    assert.equal(
      formatLettaReactionSend('👍', false, 'Looks good'),
      'Reacted 👍 to: "Looks good"'
    );
    assert.equal(
      formatLettaReactionSend('👍', true, 'Looks good'),
      'Removed 👍 from: "Looks good"'
    );
  });
});
