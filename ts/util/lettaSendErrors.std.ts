// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

export function formatLettaError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error == null) {
    return '';
  }
  return 'Unknown error';
}

export function isUnauthorized(error: unknown): boolean {
  return formatLettaError(error).includes('401 Unauthorized');
}

// Letta returns 401 for both a bad credential and an agent/conversation that
// belongs to a different account. A working directory list means the key is
// fine and the cached chat is the problem.
export function isForeignLettaChat(
  error: unknown,
  directoryReady: boolean
): boolean {
  return directoryReady && isUnauthorized(error);
}

export function isMissingLettaConversation(error: unknown): boolean {
  const detail = formatLettaError(error);
  return (
    detail.includes('404 Conversation not found') ||
    detail.includes('Conversation not found')
  );
}

export function isMissingAgent(error: unknown): boolean {
  const detail = formatLettaError(error);
  if (isMissingLettaConversation(error)) {
    return false;
  }
  return /agent(?:\s+agent-[0-9a-f-]+)?\s+not found/i.test(detail);
}

export function baseAgentName(name: string): string {
  return name.replace(/ \([0-9a-f]{6}\)$/i, '').trim();
}
