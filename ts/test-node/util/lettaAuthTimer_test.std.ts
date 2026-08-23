// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  getLettaAuthTimerSegment,
  MAX_LETTA_AUTH_TIMER_DELAY_MS,
} from '../../util/lettaAuthTimer.std.ts';

describe('Letta auth refresh timer', () => {
  it('uses ordinary delays without rescheduling', () => {
    assert.deepEqual(getLettaAuthTimerSegment(60_000), {
      delayMs: 60_000,
      needsReschedule: false,
    });
  });

  it('clamps 30-day token waits to Node safe timer segments', () => {
    assert.deepEqual(getLettaAuthTimerSegment(30 * 24 * 60 * 60_000), {
      delayMs: MAX_LETTA_AUTH_TIMER_DELAY_MS,
      needsReschedule: true,
    });
  });

  it('normalizes expired targets to an immediate refresh', () => {
    assert.deepEqual(getLettaAuthTimerSegment(-1), {
      delayMs: 0,
      needsReschedule: false,
    });
  });
});
