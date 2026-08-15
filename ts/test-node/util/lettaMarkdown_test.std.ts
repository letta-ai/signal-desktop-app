// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import { assert } from 'chai';

import { BodyRange } from '../../types/BodyRange.std.ts';
import { formatLettaMarkdown } from '../../util/lettaMarkdown.std.ts';

describe('formatLettaMarkdown', () => {
  it('formats headings and nested inline styles', () => {
    assert.deepEqual(
      formatLettaMarkdown('## Direct **answer**\nUse *fewer* bets.'),
      {
        body: 'Direct answer\nUse fewer bets.',
        bodyRanges: [
          {
            start: 7,
            length: 6,
            style: BodyRange.Style.BOLD,
          },
          {
            start: 0,
            length: 13,
            style: BodyRange.Style.BOLD,
          },
          {
            start: 18,
            length: 5,
            style: BodyRange.Style.ITALIC,
          },
        ],
      }
    );
  });

  it('formats lists, tasks, quotes, and code fences', () => {
    assert.deepEqual(
      formatLettaMarkdown(
        '- first\n- [x] done\n> quoted\n```ts\nconst value = 1;\n```'
      ),
      {
        body: '• first\n☑ done\nquoted\nconst value = 1;',
        bodyRanges: [
          {
            start: 15,
            length: 6,
            style: BodyRange.Style.ITALIC,
          },
          {
            start: 22,
            length: 16,
            style: BodyRange.Style.MONOSPACE,
          },
        ],
      }
    );
  });

  it('leaves unmatched formatting markers visible while streaming', () => {
    assert.deepEqual(formatLettaMarkdown('Still **working'), {
      body: 'Still **working',
      bodyRanges: [],
    });
  });

  it('does not treat underscores inside identifiers as italics', () => {
    assert.deepEqual(formatLettaMarkdown('context_window_limit'), {
      body: 'context_window_limit',
      bodyRanges: [],
    });
  });
});
