// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import { v5 as uuidv5 } from 'uuid';

import type { AciString } from '../types/ServiceId.std.ts';
import { LETTA_ACI_NAMESPACE } from './lettaMode.std.ts';
import { baseAgentName } from './lettaSendErrors.std.ts';

export type LettaDirectoryAgent = Readonly<{
  id: string;
  name?: string | null;
  hidden?: boolean | null;
}>;

export function legacyAddressForAgent(agentId: string): string {
  return uuidv5(agentId, LETTA_ACI_NAMESPACE);
}

export function aciForAgent(agentId: string): AciString {
  const uuid = legacyAddressForAgent(agentId);
  // Signal accepts v4 and v7 service IDs. UUID v5 gives us stable hashing, so
  // preserve its bits and mark the result as v4 for the local synthetic ACI.
  return `${uuid.slice(0, 14)}4${uuid.slice(15)}` as AciString;
}

export function filterMappedLettaConversations<T extends { id: string }>(
  conversations: ReadonlyArray<T>,
  mappedIds: ReadonlySet<string> | undefined
): Array<T> {
  if (!mappedIds) {
    return [...conversations];
  }
  return conversations.filter(conversation => mappedIds.has(conversation.id));
}

// Search can still surface a leftover Signal chat after an account switch.
// Match the open conversation to a live directory agent by ACI first, then by
// a unique name. Ambiguous names without an ACI hit are not recovered.
export function matchDirectoryAgent(input: {
  serviceId?: string;
  conversationName?: string;
  agents: ReadonlyArray<LettaDirectoryAgent>;
}): LettaDirectoryAgent | undefined {
  const visible = input.agents.filter(
    agent => agent.hidden !== true && Boolean(agent.id)
  );
  const serviceId = input.serviceId;
  if (serviceId) {
    const byIdentity = visible.find(
      agent =>
        aciForAgent(agent.id) === serviceId ||
        legacyAddressForAgent(agent.id) === serviceId
    );
    if (byIdentity) {
      return byIdentity;
    }
  }

  const rawName = (input.conversationName ?? '').trim().toLocaleLowerCase();
  const baseName = baseAgentName(
    input.conversationName ?? ''
  ).toLocaleLowerCase();
  const namesToMatch = new Set(
    [rawName, baseName].filter(name => name.length > 0)
  );
  if (namesToMatch.size === 0) {
    return undefined;
  }
  const nameMatches = visible.filter(agent =>
    namesToMatch.has((agent.name?.trim() ?? '').toLocaleLowerCase())
  );
  if (nameMatches.length === 1) {
    return nameMatches[0];
  }
  return undefined;
}
