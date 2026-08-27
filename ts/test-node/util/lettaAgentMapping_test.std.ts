// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import { assert } from 'chai';

import {
  aciForAgent,
  filterMappedLettaConversations,
  legacyAddressForAgent,
  matchDirectoryAgent,
} from '../../util/lettaAgentMapping.std.ts';

const GRUNK_ID = 'agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_GRUNK_ID = 'agent-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('lettaAgentMapping', () => {
  it('matches a leftover chat when the Signal ACI belongs to a live agent', () => {
    const live = { id: GRUNK_ID, name: 'grunk' };
    assert.equal(
      matchDirectoryAgent({
        serviceId: aciForAgent(GRUNK_ID),
        conversationName: 'stale title',
        agents: [live, { id: OTHER_GRUNK_ID, name: 'inventory-assistant' }],
      })?.id,
      GRUNK_ID
    );
    assert.equal(
      matchDirectoryAgent({
        serviceId: legacyAddressForAgent(GRUNK_ID),
        conversationName: 'grunk',
        agents: [live],
      })?.id,
      GRUNK_ID
    );
  });

  it('recovers a uniquely named directory agent when the leftover ACI is from another account', () => {
    assert.equal(
      matchDirectoryAgent({
        serviceId: aciForAgent(OTHER_GRUNK_ID),
        conversationName: 'grunk',
        agents: [{ id: GRUNK_ID, name: 'grunk' }],
      })?.id,
      GRUNK_ID
    );
  });

  it('does not guess among duplicate names without an ACI hit', () => {
    assert.isUndefined(
      matchDirectoryAgent({
        serviceId: aciForAgent(OTHER_GRUNK_ID),
        conversationName: 'inventory-assistant',
        agents: [
          { id: GRUNK_ID, name: 'inventory-assistant' },
          {
            id: 'agent-cccccccc-cccc-cccc-cccc-cccccccccccc',
            name: 'inventory-assistant',
          },
        ],
      })
    );
  });

  it('ignores hidden directory rows', () => {
    assert.isUndefined(
      matchDirectoryAgent({
        conversationName: 'grunk',
        agents: [{ id: GRUNK_ID, name: 'grunk', hidden: true }],
      })
    );
  });

  it('does not unique-match leftover base title to a suffixed live name', () => {
    assert.isUndefined(
      matchDirectoryAgent({
        serviceId: aciForAgent(OTHER_GRUNK_ID),
        conversationName: 'inventory-assistant',
        agents: [
          {
            id: 'agent-cccccccc-cccc-cccc-cccc-cccccccccccc',
            name: 'inventory-assistant (88b86e)',
          },
        ],
      })
    );
  });

  it('recovers a uniquely suffixed leftover title against the same live name', () => {
    assert.equal(
      matchDirectoryAgent({
        serviceId: aciForAgent(OTHER_GRUNK_ID),
        conversationName: 'inventory-assistant (88b86e)',
        agents: [
          {
            id: GRUNK_ID,
            name: 'inventory-assistant (88b86e)',
          },
        ],
      })?.id,
      GRUNK_ID
    );
  });

  it('does not guess when leftover suffix matches both a base and suffixed live name', () => {
    assert.isUndefined(
      matchDirectoryAgent({
        serviceId: aciForAgent(OTHER_GRUNK_ID),
        conversationName: 'inventory-assistant (88b86e)',
        agents: [
          { id: GRUNK_ID, name: 'inventory-assistant' },
          {
            id: 'agent-cccccccc-cccc-cccc-cccc-cccccccccccc',
            name: 'inventory-assistant (88b86e)',
          },
        ],
      })
    );
  });

  it('keeps leftover unmapped chats out of Letta search results', () => {
    const conversations = [{ id: 'mapped-grunk' }, { id: 'leftover-grunk' }];
    assert.deepEqual(
      filterMappedLettaConversations(
        conversations,
        new Set(['mapped-grunk'])
      ).map(conversation => conversation.id),
      ['mapped-grunk']
    );
    assert.deepEqual(
      filterMappedLettaConversations(conversations, undefined).map(
        conversation => conversation.id
      ),
      ['mapped-grunk', 'leftover-grunk']
    );
    assert.deepEqual(
      filterMappedLettaConversations(conversations, new Set()).map(
        conversation => conversation.id
      ),
      []
    );
  });
});
