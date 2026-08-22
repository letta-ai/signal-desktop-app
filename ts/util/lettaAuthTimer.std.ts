// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Node clamps larger setTimeout values to 1 ms. Letta access tokens may live
// for 30 days, so long waits must be split into safe timer-sized segments.
export const MAX_LETTA_AUTH_TIMER_DELAY_MS = 2_147_000_000;

export function getLettaAuthTimerSegment(targetDelayMs: number): Readonly<{
  delayMs: number;
  needsReschedule: boolean;
}> {
  const normalizedTarget = Math.max(0, targetDelayMs);
  return {
    delayMs: Math.min(normalizedTarget, MAX_LETTA_AUTH_TIMER_DELAY_MS),
    needsReschedule: normalizedTarget > MAX_LETTA_AUTH_TIMER_DELAY_MS,
  };
}
