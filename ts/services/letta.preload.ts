// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Letta integration service.
//
// Replaces Signal's protocol send/receive with the Letta Agent SDK. Each
// Letta agent is a private contact backed by a dedicated conversation.

import { v5 as uuidv5 } from 'uuid';
import {
  LettaAgentClient,
  CloudManagedSandboxExpiredError,
  createTranscriptAccumulator,
} from '@letta-ai/letta-agent-sdk/client';
import type {
  LettaCodeSession,
  LettaConversationMessage,
  SDKResultMessage,
  SendMessage,
  TranscriptRow,
} from '@letta-ai/letta-agent-sdk/client';

import { createLogger } from '../logging/log.std.ts';
import { drop } from '../util/drop.std.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { incrementMessageCounter } from '../util/incrementMessageCounter.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import * as Registration from '../util/registration.preload.ts';
import {
  deleteAvatar,
  maybeDeleteAttachmentFile,
  readAttachmentData,
  writeNewAttachmentData,
} from '../util/migrations.preload.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import type { RawBodyRange } from '../types/BodyRange.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { IMAGE_PNG } from '../types/MIME.std.ts';
import { ToastType, type AnyToast } from '../types/Toast.dom.tsx';
import { formatLettaMarkdown } from '../util/lettaMarkdown.std.ts';
import { cleanupMessages } from '../util/cleanup.preload.ts';
import {
  LETTA_MODE,
  LETTA_API_KEY,
  LETTA_RUNTIME_API_KEY,
  LETTA_OUR_ACI,
  LETTA_ACI_NAMESPACE,
  LETTA_LEGACY_PEER_ACI,
} from '../util/lettaMode.std.ts';
import { lettaNodeFetch } from '../util/lettaNodeFetch.node.ts';
import { isVoiceMessage } from '../util/Attachment.std.ts';

const log = createLogger('letta');
const LETTA_API_BASE_URL = 'https://api.letta.com';
const AGENT_PAGE_SIZE = 50;
const MAX_AGENT_PAGES = 8;
const MAX_AGENT_CONTACTS = 40;
const MAX_AVATAR_LOADS = 4;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
const CONTACT_CACHE_KEY = 'lettaAgentContactsV1';

const untypedStorage = itemStorage as unknown as {
  get(key: string): unknown;
  put(key: string, value: unknown): Promise<void>;
};

type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

type AgentContact = {
  agentId: string;
  name: string;
  conversationId: string;
  lettaConversationId?: string;
};

type AgentSummary = {
  id: string;
  name?: string | null;
  hidden?: boolean | null;
};

type HistoryMessage = LettaConversationMessage & {
  message_type: 'user_message' | 'assistant_message';
  content: string;
};

function isHistoryMessage(
  message: LettaConversationMessage
): message is HistoryMessage {
  return (
    'content' in message &&
    typeof message.content === 'string' &&
    (message.message_type === 'user_message' ||
      message.message_type === 'assistant_message')
  );
}

type AvatarLoad = {
  agentId: string;
  conversationId: string;
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function visibleSendError(error?: unknown): string {
  const detail = error == null ? '' : formatError(error);
  if (detail.includes('Insufficient credits')) {
    return 'Message not sent. Add at least $1 in Letta organization credits.';
  }
  if (detail.includes('401 Unauthorized')) {
    return 'Message not sent. Letta authentication failed.';
  }
  if (detail.includes('Cloud managed sandbox session closed')) {
    return 'Message not sent. The Letta execution environment closed during startup.';
  }
  if (
    detail.includes('approval_conflict') ||
    detail.includes('requires_approval') ||
    detail.includes('waiting for approval') ||
    detail.includes('No canUseTool callback registered')
  ) {
    return 'Message stopped because a tool approval could not be completed. Try again.';
  }
  if (detail.includes('Too many image attachments')) {
    return `Message not sent. Attach no more than ${MAX_IMAGE_ATTACHMENTS} images.`;
  }
  if (detail.includes('TRANSCRIPTION_KEY_MISSING')) {
    return 'Message not sent. Add a key for the selected transcription service in Settings.';
  }
  if (
    detail.includes('TRANSCRIPTION_SECURE_STORAGE_UNAVAILABLE') ||
    detail.includes('TRANSCRIPTION_KEY_UNREADABLE')
  ) {
    return 'Message not sent. Secure transcription key storage is unavailable.';
  }
  if (detail.includes('TRANSCRIPTION_AUTH')) {
    return 'Message not sent. The transcription service rejected the saved key.';
  }
  if (detail.includes('TRANSCRIPTION_RATE_LIMIT')) {
    return 'Message not sent. The transcription service rate limit was reached.';
  }
  if (detail.includes('TRANSCRIPTION_AUDIO_INVALID')) {
    return 'Message not sent. The voice memo could not be transcribed.';
  }
  if (detail.includes('TRANSCRIPTION_TIMEOUT')) {
    return 'Message not sent. Voice memo transcription timed out.';
  }
  if (
    detail.includes('TRANSCRIPTION_NETWORK') ||
    detail.includes('TRANSCRIPTION_SERVICE') ||
    detail.includes('TRANSCRIPTION_EMPTY')
  ) {
    return 'Message not sent. The transcription service did not return text.';
  }
  if (detail.includes('Unsupported attachment type')) {
    return 'Message not sent. Use PNG, JPEG, GIF, or WebP images.';
  }
  if (detail.includes('Image attachment is too large')) {
    return 'Message not sent. One of the images is too large.';
  }
  return 'Message not sent. Unable to reach Letta.';
}

function bodyRangesEqual(
  left: unknown,
  right: ReadonlyArray<RawBodyRange>
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

function legacyAddressForAgent(agentId: string): string {
  return uuidv5(agentId, LETTA_ACI_NAMESPACE);
}

function aciForAgent(agentId: string): AciString {
  const uuid = legacyAddressForAgent(agentId);
  // Signal accepts v4 and v7 service IDs. UUID v5 gives us stable hashing, so
  // preserve its bits and mark the result as v4 for the local synthetic ACI.
  return `${uuid.slice(0, 14)}4${uuid.slice(15)}` as AciString;
}

function signalMessageIdForRemote(remoteMessageId: string): string {
  const uuid = uuidv5(remoteMessageId, LETTA_ACI_NAMESPACE);
  return `${uuid.slice(0, 14)}4${uuid.slice(15)}`;
}

function displayName(
  agent: { name?: string | null; id?: string },
  used: Set<string>
): string {
  const base =
    agent.name?.trim() ||
    (agent.id ? `Agent ${agent.id.slice(6, 14)}` : 'Letta agent');
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const suffix = (agent.id ?? '').replace(/^agent-/, '').slice(0, 6);
  const unique = suffix ? `${base} (${suffix})` : base;
  used.add(unique);
  return unique;
}

function isSupportedImageMediaType(
  value: string
): value is SupportedImageMediaType {
  return SUPPORTED_IMAGE_MEDIA_TYPES.some(mediaType => mediaType === value);
}

function isClosedCloudSession(error: unknown): boolean {
  return (
    error instanceof CloudManagedSandboxExpiredError ||
    (error instanceof Error &&
      error.message.includes(
        'Cloud managed sandbox session closed during initialization'
      ))
  );
}

class LettaService {
  #client: LettaAgentClient | undefined;
  #directoryClient: LettaAgentClient | undefined;
  #initPromise: Promise<void> | undefined;
  #initError: string | undefined;
  readonly #contacts = new Map<string, AgentContact>();
  readonly #sessions = new Map<string, LettaCodeSession>();
  readonly #typingRefreshTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  readonly #avatarQueue: Array<AvatarLoad> = [];
  readonly #queuedAvatarAgentIds = new Set<string>();
  #activeAvatarLoads = 0;
  #restoringContacts = false;
  #visibleSendErrorToast: AnyToast | undefined;

  // Serializes turns per conversation. The SDK stream() drains one shared
  // queue per session, so only one turn may run at a time for that agent.
  readonly #turnChains = new Map<string, Promise<unknown>>();

  isEnabled(): boolean {
    return LETTA_MODE;
  }

  async seedIdentity(): Promise<void> {
    if (!LETTA_MODE) {
      return;
    }
    try {
      if (itemStorage.user.getAci() !== LETTA_OUR_ACI) {
        await itemStorage.user.setAciAndDeviceId(LETTA_OUR_ACI as AciString, 1);
      }
      if (!Registration.everDone()) {
        await Registration.markDone();
      }
      if (itemStorage.get('backupDownloadPath')) {
        await itemStorage.remove('backupDownloadPath');
      }
      // Hide Signal's leftover onboarding cards.
      if (!itemStorage.get('hasCompletedUsernameOnboarding')) {
        await itemStorage.put('hasCompletedUsernameOnboarding', true);
      }
      log.info('seedIdentity: local Letta identity ready');
    } catch (error) {
      log.error('seedIdentity failed', formatError(error));
    }
  }

  async bootstrapConversation(): Promise<void> {
    if (!LETTA_MODE) {
      return;
    }
    try {
      await this.initialize();
      if (this.#contacts.size === 0) {
        log.warn('bootstrapConversation: no agent contacts');
        return;
      }

      const ourId = window.ConversationController.getOurConversationId();
      const keep = new Set(
        [...this.#contacts.values()].map(contact => contact.conversationId)
      );
      if (ourId) {
        keep.add(ourId);
      }

      for (const other of window.ConversationController.getAll()) {
        if (keep.has(other.id)) {
          continue;
        }
        if (other.get('active_at') != null || other.get('isPinned')) {
          other.set({ active_at: null, isPinned: false });
          drop(DataWriter.updateConversation(other.attributes));
        }
      }

      const mostRecent = [...this.#contacts.values()]
        .map(contact => ({
          contact,
          conversation: window.ConversationController.get(
            contact.conversationId
          ),
        }))
        .filter(({ conversation }) => conversation?.get('active_at') != null)
        .map(({ contact, conversation }) => ({
          contact,
          timestamp: conversation?.get('timestamp') ?? 0,
        }))
        .sort((left, right) => right.timestamp - left.timestamp)[0]?.contact;
      if (mostRecent) {
        window.reduxActions.conversations.showConversation({
          conversationId: mostRecent.conversationId,
          switchToAssociatedView: true,
        });
      }
      log.info('bootstrapConversation: agent contacts ready', {
        count: this.#contacts.size,
      });
    } catch (error) {
      log.error('bootstrapConversation failed', formatError(error));
    }
  }

  initialize(): Promise<void> {
    if (!LETTA_MODE) {
      return Promise.resolve();
    }
    this.#initPromise ??= this.#doInitialize();
    return this.#initPromise;
  }

  async #doInitialize(): Promise<void> {
    if (!LETTA_API_KEY || !LETTA_RUNTIME_API_KEY) {
      this.#initError =
        'No Letta credentials. Set LETTA_API_KEY and LETTA_RUNTIME_API_KEY.';
      log.error(this.#initError);
      return;
    }

    this.#client = new LettaAgentClient({
      backend: 'cloud',
      apiKey: LETTA_RUNTIME_API_KEY,
      webSocketAuth: 'query',
      requestTimeoutMs: 600_000,
      fetch: lettaNodeFetch as typeof fetch,
    } as ConstructorParameters<typeof LettaAgentClient>[0]);
    this.#directoryClient = new LettaAgentClient({
      backend: 'cloud',
      apiKey: LETTA_API_KEY,
      webSocketAuth: 'query',
      requestTimeoutMs: 600_000,
      fetch: lettaNodeFetch as typeof fetch,
    } as ConstructorParameters<typeof LettaAgentClient>[0]);

    try {
      const restored = await this.#restoreCachedContacts();
      if (restored > 0) {
        log.info('restored cached agent contacts', { count: restored });
        drop(this.#loadAgentContacts());
      } else {
        await this.#loadAgentContacts();
      }
    } catch (error) {
      this.#initError = `Could not list Letta agents: ${formatError(error)}`;
      log.error(this.#initError);
    }
  }

  async #loadAgentContacts(): Promise<void> {
    if (!this.#client) {
      return;
    }

    const usedNames = new Set(
      [...this.#contacts.values()].map(contact => contact.name)
    );
    const firstBatch = await this.#listAgentPage();
    await this.#addAgentContacts(firstBatch, usedNames);

    const legacy = window.ConversationController.get(LETTA_LEGACY_PEER_ACI);
    if (legacy && !this.#contacts.has(legacy.id)) {
      legacy.set({ active_at: null, isPinned: false });
      drop(DataWriter.updateConversation(legacy.attributes));
    }

    log.info('loaded agent contacts', {
      count: this.#contacts.size,
      names: [...this.#contacts.values()].map(contact => contact.name),
    });
    await this.#persistContacts();

    if (this.#contacts.size === 0) {
      log.warn('no named people agents found; inbox stays empty until search');
    }

    const after = firstBatch[firstBatch.length - 1]?.id;
    if (
      after &&
      firstBatch.length === AGENT_PAGE_SIZE &&
      this.#contacts.size < MAX_AGENT_CONTACTS
    ) {
      drop(this.#loadMoreAgentContacts(after, usedNames));
    }
  }

  async #listAgentPage(after?: string): Promise<Array<AgentSummary>> {
    if (!this.#directoryClient) {
      return [];
    }
    return this.#directoryClient.agents.list({
      limit: AGENT_PAGE_SIZE,
      order: 'desc',
      orderBy: 'createdAt',
      after,
    });
  }

  async #loadMoreAgentContacts(
    initialAfter: string,
    usedNames: Set<string>
  ): Promise<void> {
    let after: string | undefined = initialAfter;
    for (let page = 1; page < MAX_AGENT_PAGES; page += 1) {
      let batch: Array<AgentSummary>;
      try {
        // Pages depend on the cursor returned by the previous page.
        // oxlint-disable-next-line no-await-in-loop
        batch = await this.#listAgentPage(after);
      } catch (error) {
        log.warn('agents.list page failed', formatError(error));
        break;
      }
      if (batch.length === 0) {
        break;
      }
      // Preserve contact limits and stable duplicate-name suffixes across pages.
      // oxlint-disable-next-line no-await-in-loop
      await this.#addAgentContacts(batch, usedNames);
      // oxlint-disable-next-line no-await-in-loop
      await this.#persistContacts();
      log.info('loaded more agent contacts', { count: this.#contacts.size });
      if (this.#contacts.size >= MAX_AGENT_CONTACTS) {
        break;
      }
      after = batch[batch.length - 1]?.id;
      if (batch.length < AGENT_PAGE_SIZE) {
        break;
      }
    }
  }

  async #addAgentContacts(
    agents: Array<AgentSummary>,
    usedNames: Set<string>
  ): Promise<void> {
    const remaining = MAX_AGENT_CONTACTS - this.#contacts.size;
    if (remaining <= 0) {
      return;
    }
    const chosen = this.#chooseAgentContacts(agents).slice(0, remaining);
    for (const agent of chosen) {
      // Contact creation mutates the shared name and contact indexes.
      // oxlint-disable-next-line no-await-in-loop
      await this.#ensureContact(agent, usedNames);
    }
  }

  #chooseAgentContacts(agents: Array<AgentSummary>): Array<AgentSummary> {
    const visible = agents.filter(agent => agent.hidden !== true);
    const named = visible.filter(agent => {
      const name = agent.name?.trim() ?? '';
      return name.length > 0 && !this.#isFactoryAgentName(name);
    });
    return named;
  }

  #isFactoryAgentName(name: string): boolean {
    return name === 'Letta Code' || name.startsWith('Parity Probe');
  }

  async searchAgents(query: string): Promise<Array<string>> {
    const trimmed = query.trim();
    if (!LETTA_MODE || !trimmed) {
      return [];
    }
    await this.initialize();
    if (!this.#directoryClient) {
      return [];
    }

    const needle = trimmed.toLocaleLowerCase();
    const conversationIds = [...this.#contacts.values()]
      .filter(
        contact =>
          contact.name.toLocaleLowerCase().includes(needle) ||
          contact.agentId.toLocaleLowerCase().includes(needle)
      )
      .map(contact => contact.conversationId);
    const seenConversationIds = new Set(conversationIds);

    const found = new Map<
      string,
      { id: string; name?: string | null; hidden?: boolean | null }
    >();
    const add = (
      agents: Array<{
        id: string;
        name?: string | null;
        hidden?: boolean | null;
      }>
    ) => {
      for (const agent of agents) {
        if (agent.hidden === true || !agent.id) {
          continue;
        }
        found.set(agent.id, agent);
      }
    };

    try {
      add(
        await this.#directoryClient.agents.list({
          query: trimmed,
          limit: 20,
          order: 'desc',
          orderBy: 'createdAt',
        })
      );
    } catch (error) {
      log.warn('searchAgents query failed', formatError(error));
    }

    try {
      add(
        await this.#directoryClient.agents.list({
          name: trimmed,
          limit: 20,
          order: 'desc',
          orderBy: 'createdAt',
        })
      );
    } catch (error) {
      log.warn('searchAgents name failed', formatError(error));
    }

    if (/^agent-[0-9a-f-]{36}$/i.test(trimmed)) {
      try {
        const agent = await this.#directoryClient.agents.retrieve(trimmed);
        add([agent]);
      } catch (error) {
        log.warn('searchAgents retrieve failed', formatError(error));
      }
    }

    const usedNames = new Set(
      [...this.#contacts.values()].map(contact => contact.name)
    );
    for (const agent of found.values()) {
      // Contact creation mutates the shared name and contact indexes.
      // oxlint-disable-next-line no-await-in-loop
      const conversationId = await this.#ensureContact(agent, usedNames);
      if (conversationId && !seenConversationIds.has(conversationId)) {
        seenConversationIds.add(conversationId);
        conversationIds.push(conversationId);
      }
    }
    log.info('searchAgents', { query: trimmed, count: conversationIds.length });
    return conversationIds;
  }

  async #ensureContact(
    agent: { id: string; name?: string | null },
    usedNames: Set<string>
  ): Promise<string | undefined> {
    const existing = [...this.#contacts.values()].find(
      contact => contact.agentId === agent.id
    );
    if (existing) {
      const conversation = window.ConversationController.get(
        existing.conversationId
      );
      if (conversation) {
        const serviceId = aciForAgent(agent.id);
        if (conversation.getServiceId() !== serviceId) {
          conversation.updateServiceId(serviceId);
          conversation.updateE164(undefined);
        }
        drop(DataWriter.updateConversation(conversation.attributes));
      }
      this.#queueAvatarLoad(agent.id, existing.conversationId);
      return existing.conversationId;
    }

    const name = displayName(agent, usedNames);
    const serviceId = aciForAgent(agent.id);
    const legacyAddress = legacyAddressForAgent(agent.id);
    const legacyConversation = window.ConversationController.get(legacyAddress);
    let conversation;
    if (legacyConversation) {
      const merged = window.ConversationController.maybeMergeContacts({
        aci: serviceId,
        e164: legacyAddress,
        reason: 'LettaService.ensureContact',
      });
      await Promise.all(merged.mergePromises);
      conversation = merged.conversation;
      conversation.updateE164(undefined);
    } else {
      conversation = await window.ConversationController.getOrCreateAndWait(
        serviceId,
        'private',
        {
          active_at: null,
          profileSharing: true,
          name,
          systemGivenName: name,
          profileName: name,
        }
      );
    }
    conversation.set({
      name,
      systemGivenName: name,
      profileName: name,
      profileSharing: true,
      discoveredUnregisteredAt: undefined,
      firstUnregisteredAt: undefined,
    });
    drop(DataWriter.updateConversation(conversation.attributes));
    this.#contacts.set(conversation.id, {
      agentId: agent.id,
      name,
      conversationId: conversation.id,
    });
    if (!this.#restoringContacts) {
      await this.#persistContacts();
    }
    this.#queueAvatarLoad(agent.id, conversation.id);
    return conversation.id;
  }

  async #restoreCachedContacts(): Promise<number> {
    const cached = untypedStorage.get(CONTACT_CACHE_KEY);
    if (!Array.isArray(cached)) {
      return 0;
    }

    const usedNames = new Set<string>();
    this.#restoringContacts = true;
    try {
      for (const value of cached.slice(0, 100)) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        const { agentId, name, lettaConversationId } = value as {
          agentId?: unknown;
          name?: unknown;
          lettaConversationId?: unknown;
        };
        if (
          typeof agentId !== 'string' ||
          !/^agent-[0-9a-f-]{36}$/i.test(agentId) ||
          typeof name !== 'string' ||
          !name.trim()
        ) {
          continue;
        }
        // Contact restoration may merge an older synthetic identity.
        // oxlint-disable-next-line no-await-in-loop
        const conversationId = await this.#ensureContact(
          { id: agentId, name },
          usedNames
        );
        const restored = conversationId
          ? this.#contacts.get(conversationId)
          : undefined;
        if (
          restored &&
          typeof lettaConversationId === 'string' &&
          /^conv-[0-9a-f-]{36}$/i.test(lettaConversationId)
        ) {
          restored.lettaConversationId = lettaConversationId;
        }
      }
    } finally {
      this.#restoringContacts = false;
    }
    await Promise.all(
      [...this.#contacts.values()].map(async contact => {
        await this.#removeLegacyErrorBubbles(contact);
        await this.#hydrateRemoteHistory(contact);
        await this.#reconcileContactVisibility(contact);
      })
    );
    return this.#contacts.size;
  }

  async #persistContacts(): Promise<void> {
    await untypedStorage.put(
      CONTACT_CACHE_KEY,
      [...this.#contacts.values()].map(
        ({ agentId, name, lettaConversationId }) => ({
          agentId,
          name,
          lettaConversationId,
        })
      )
    );
  }

  async #reconcileContactVisibility(contact: AgentContact): Promise<void> {
    const conversation = window.ConversationController.get(
      contact.conversationId
    );
    if (!conversation) {
      return;
    }
    const lastMessage = await DataReader.getLastConversationMessage({
      conversationId: conversation.id,
    });
    const hasDraft = Boolean(conversation.get('draft')?.trim());
    const hasStarted = Boolean(
      contact.lettaConversationId || lastMessage || hasDraft
    );
    const activeAt = conversation.get('active_at');
    const nextActiveAt = hasStarted
      ? (activeAt ?? lastMessage?.timestamp ?? Date.now())
      : null;
    if (activeAt === nextActiveAt) {
      return;
    }
    conversation.set({ active_at: nextActiveAt });
    await DataWriter.updateConversation(conversation.attributes);
  }

  async #removeLegacyErrorBubbles(contact: AgentContact): Promise<void> {
    const conversation = window.ConversationController.get(
      contact.conversationId
    );
    if (!conversation) {
      return;
    }
    const messages = await DataReader.getOlderMessagesByConversation({
      conversationId: conversation.id,
      includeStoryReplies: true,
      limit: 1000,
      storyId: undefined,
    });
    const legacyErrors = messages.filter(
      message =>
        message.type === 'incoming' &&
        typeof message.body === 'string' &&
        (message.body.startsWith('Failed to reach Letta:') ||
          message.body.startsWith('Stream error:') ||
          message.body.startsWith('Agent error:'))
    );
    await Promise.all(
      legacyErrors.map(message =>
        DataWriter.removeMessageById(message.id, {
          fromSync: true,
          cleanupMessages,
        })
      )
    );
    if (legacyErrors.length > 0) {
      await conversation.updateLastMessage();
      log.info('removed legacy error bubbles', {
        agentId: contact.agentId,
        count: legacyErrors.length,
      });
    }
  }

  async #hydrateRemoteHistory(contact: AgentContact): Promise<void> {
    if (!LETTA_API_KEY || !contact.lettaConversationId) {
      return;
    }
    const conversation = window.ConversationController.get(
      contact.conversationId
    );
    if (!conversation) {
      return;
    }
    if (
      await DataReader.getLastConversationMessage({
        conversationId: conversation.id,
      })
    ) {
      return;
    }

    if (!this.#directoryClient) {
      return;
    }
    let payload;
    try {
      payload = await this.#directoryClient.conversations.listMessages(
        contact.lettaConversationId,
        { limit: 100 }
      );
    } catch (error) {
      log.warn('remote history request failed', {
        agentId: contact.agentId,
        error: formatError(error),
      });
      return;
    }
    // The SDK returns the newest page first. Signal inserts history chronologically.
    const messages = payload.messages.filter(isHistoryMessage).reverse();

    let inserted = 0;
    for (const remote of messages) {
      const remoteId = remote.id;
      const content = remote.content;
      if (!remoteId || content == null) {
        continue;
      }
      const id = signalMessageIdForRemote(remoteId);
      // Preserve chronological insertion and notification order.
      // oxlint-disable-next-line no-await-in-loop
      if (await DataReader.getMessageById(id)) {
        continue;
      }
      const isIncoming = remote.message_type === 'assistant_message';
      const date = Date.parse(remote.date ?? '');
      const timestamp = Number.isFinite(date) ? date : Date.now();
      const formatted = isIncoming
        ? formatLettaMarkdown(content)
        : { body: content, bodyRanges: [] };
      const attributes = {
        ...generateMessageId(incrementMessageCounter()),
        id,
        conversationId: conversation.id,
        type: isIncoming ? ('incoming' as const) : ('outgoing' as const),
        body: formatted.body,
        bodyRanges: formatted.bodyRanges,
        sent_at: timestamp,
        timestamp,
        received_at_ms: timestamp,
        ...(isIncoming
          ? {
              sourceServiceId: conversation.getServiceId(),
              sourceDevice: 1,
            }
          : {
              sendStateByConversationId: {
                [conversation.id]: {
                  status: SendStatus.Delivered,
                  updatedAt: timestamp,
                },
              },
            }),
        readStatus: ReadStatus.Read,
        seenStatus: isIncoming ? SeenStatus.Seen : SeenStatus.NotApplicable,
      } as unknown as MessageAttributesType;
      const model = window.MessageCache.register(new MessageModel(attributes));
      // oxlint-disable-next-line no-await-in-loop
      await window.MessageCache.saveMessage(model, { forceSave: true });
      // oxlint-disable-next-line no-await-in-loop
      await conversation.onNewMessage(model);
      inserted += 1;
    }
    if (inserted > 0) {
      await conversation.updateLastMessage();
      log.info('hydrated remote conversation history', {
        agentId: contact.agentId,
        inserted,
      });
    }
  }

  #queueAvatarLoad(agentId: string, conversationId: string): void {
    if (this.#queuedAvatarAgentIds.has(agentId)) {
      return;
    }
    this.#queuedAvatarAgentIds.add(agentId);
    this.#avatarQueue.push({ agentId, conversationId });
    this.#drainAvatarQueue();
  }

  #drainAvatarQueue(): void {
    while (
      this.#activeAvatarLoads < MAX_AVATAR_LOADS &&
      this.#avatarQueue.length > 0
    ) {
      const item = this.#avatarQueue.shift();
      if (!item) {
        return;
      }
      this.#activeAvatarLoads += 1;
      void this.#runAvatarLoad(item);
    }
  }

  async #runAvatarLoad(item: AvatarLoad): Promise<void> {
    try {
      await this.#loadAvatar(item);
    } finally {
      this.#activeAvatarLoads -= 1;
      this.#drainAvatarQueue();
    }
  }

  async #loadAvatar({ agentId, conversationId }: AvatarLoad): Promise<void> {
    if (!LETTA_API_KEY) {
      return;
    }
    const response = await lettaNodeFetch(
      `${LETTA_API_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/profile-picture`,
      {
        headers: {
          Authorization: `Bearer ${LETTA_API_KEY}`,
          Accept: 'application/json',
        },
      }
    );
    if (response.status === 403 || response.status === 404) {
      return;
    }
    if (!response.ok) {
      log.warn('profile picture request failed', {
        agentId,
        status: response.status,
      });
      return;
    }

    const payload = (await response.json()) as {
      data_url?: string;
      commit_sha?: string | null;
    };
    const match = payload.data_url?.match(/^data:[^,]*;base64,(.+)$/s);
    if (!match) {
      log.warn('profile picture response had no base64 image', { agentId });
      return;
    }

    const conversation = window.ConversationController.get(conversationId);
    if (!conversation) {
      return;
    }
    const oldAvatar = conversation.get('avatar');
    const oldProfileAvatar = conversation.get('profileAvatar');
    const avatarRevision = payload.commit_sha
      ? `letta:${payload.commit_sha}`
      : undefined;
    if (
      avatarRevision &&
      oldAvatar?.path &&
      oldAvatar.hash === payload.commit_sha &&
      oldAvatar.url === avatarRevision &&
      oldAvatar.contentType === IMAGE_PNG &&
      oldProfileAvatar?.path &&
      oldProfileAvatar.hash === payload.commit_sha &&
      oldProfileAvatar.url === avatarRevision &&
      oldProfileAvatar.contentType === IMAGE_PNG
    ) {
      return;
    }

    const base64 = match[1];
    if (!base64) {
      return;
    }
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) {
      log.warn('profile picture size rejected', {
        agentId,
        bytes: bytes.byteLength,
      });
      return;
    }

    const localAvatar = await writeNewAttachmentData(bytes);
    const contactAvatar = {
      ...localAvatar,
      contentType: IMAGE_PNG,
      hash: payload.commit_sha ?? undefined,
      url: avatarRevision,
    };
    conversation.set({
      avatar: contactAvatar,
      profileAvatar: contactAvatar,
    });
    await DataWriter.updateConversation(conversation.attributes);

    const previousAvatars = new Map<string, NonNullable<typeof oldAvatar>>();
    for (const avatar of [oldAvatar, oldProfileAvatar]) {
      if (avatar?.path && avatar.path !== localAvatar.path) {
        previousAvatars.set(avatar.path, avatar);
      }
    }
    await Promise.all(
      [...previousAvatars.entries()].map(([path, avatar]) =>
        avatar.url?.startsWith('letta:')
          ? maybeDeleteAttachmentFile(path)
          : deleteAvatar(path)
      )
    );
    const formatted = conversation.format();
    log.info('loaded MemFS profile picture', {
      agentId,
      bytes: bytes.byteLength,
      hasAvatar: formatted.hasAvatar,
      hasAvatarUrl: Boolean(formatted.avatarUrl),
    });
  }

  sendText(outgoingModel: MessageModel): Promise<void> {
    if (!LETTA_MODE) {
      return Promise.resolve();
    }
    const conversationId = outgoingModel.get('conversationId') ?? '';
    const body = (outgoingModel.get('body') ?? '').trim();
    const previous = this.#turnChains.get(conversationId) ?? Promise.resolve();
    const next = (async () => {
      await previous;
      try {
        await this.#runTurn(conversationId, body, outgoingModel);
      } catch (error) {
        log.error('turn failed', formatError(error));
      }
    })();
    this.#turnChains.set(conversationId, next);
    return Promise.resolve();
  }

  async #prepareSendMessage(
    outgoingModel: MessageModel,
    text: string
  ): Promise<
    | {
        message: SendMessage;
        inputTextLength: number;
        imageCount: number;
        imageBytes: number;
      }
    | undefined
  > {
    const attachments = outgoingModel.get('attachments') ?? [];
    if (attachments.length === 0) {
      return text
        ? {
            message: text,
            inputTextLength: text.length,
            imageCount: 0,
            imageBytes: 0,
          }
        : undefined;
    }
    const voiceMemos = attachments.filter(isVoiceMessage);
    if (voiceMemos.length > 0) {
      if (voiceMemos.length !== 1 || attachments.length !== 1) {
        throw new Error('Voice memo must be the only attachment');
      }
      const attachment = voiceMemos[0];
      if (!attachment) {
        throw new Error('Voice memo attachment is missing');
      }
      const mediaType = String(attachment.contentType ?? '')
        .split(';', 1)[0]
        .toLowerCase();
      const bytes = attachment.data ?? (await readAttachmentData(attachment));
      const transcript = await window.IPC.transcribeLettaVoiceMemo({
        data: bytes,
        contentType: mediaType,
      });
      return {
        message: transcript,
        inputTextLength: transcript.length,
        imageCount: 0,
        imageBytes: 0,
      };
    }
    if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
      throw new Error('Too many image attachments');
    }

    const typedAttachments = attachments.map(attachment => {
      const mediaType = String(attachment.contentType ?? '')
        .split(';', 1)[0]
        .toLowerCase();
      if (!isSupportedImageMediaType(mediaType)) {
        throw new Error('Unsupported attachment type');
      }
      if (attachment.size && attachment.size > MAX_IMAGE_BYTES) {
        throw new Error('Image attachment is too large');
      }
      return { attachment, mediaType };
    });
    const images = await Promise.all(
      typedAttachments.map(async ({ attachment, mediaType }) => {
        const bytes = attachment.data ?? (await readAttachmentData(attachment));
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error('Image attachment size is invalid');
        }
        return {
          content: {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: mediaType,
              data: Buffer.from(bytes).toString('base64'),
            },
          },
          bytes: bytes.byteLength,
        };
      })
    );
    const imageBytes = images.reduce((total, image) => total + image.bytes, 0);
    if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error('Combined image attachments are too large');
    }

    return {
      message: [
        { type: 'text', text: text || '[Image]' },
        ...images.map(image => image.content),
      ],
      inputTextLength: text.length,
      imageCount: images.length,
      imageBytes,
    };
  }

  async #runTurn(
    conversationId: string,
    text: string,
    outgoingModel: MessageModel
  ): Promise<void> {
    this.#startTyping(conversationId);
    try {
      await this.initialize();
      let contact = this.#contacts.get(conversationId);
      if (!contact || !this.#client) {
        this.#markOutgoingFailed(outgoingModel);
        return;
      }

      let prepared;
      try {
        prepared = await this.#prepareSendMessage(outgoingModel, text);
      } catch (error) {
        log.error('message attachment preparation failed', {
          signalConversationId: conversationId,
          signalMessageId: outgoingModel.id,
          attachmentCount: outgoingModel.get('attachments')?.length ?? 0,
          error: formatError(error),
        });
        this.#markOutgoingFailed(outgoingModel, error);
        return;
      }
      if (!prepared) {
        this.#markOutgoingDelivered(outgoingModel);
        return;
      }

      const turnContext = {
        signalConversationId: conversationId,
        signalMessageId: outgoingModel.id,
        agentId: contact.agentId,
        agentName: contact.name,
        textLength: prepared.inputTextLength,
        imageCount: prepared.imageCount,
        imageBytes: prepared.imageBytes,
      };
      log.info('turn started', turnContext);

      let session: LettaCodeSession;
      try {
        session = await this.#sessionFor(contact);
        contact = this.#contacts.get(conversationId) ?? contact;
        session = await this.#sendWithRecovery(
          contact,
          session,
          prepared.message
        );
      } catch (error) {
        log.error('session.send failed', {
          ...turnContext,
          error: formatError(error),
        });
        this.#markOutgoingFailed(outgoingModel, error);
        return;
      }

      this.#markOutgoingDelivered(outgoingModel);

      const transcript = createTranscriptAccumulator();
      const bubbles = new Map<string, MessageModel>();
      try {
        for await (const message of session.stream()) {
          const rows = transcript.apply(message);
          if (
            bubbles.size === 0 &&
            rows.some(row => row.kind === 'assistant')
          ) {
            this.#setTyping(conversationId, false);
          }
          await this.#renderRows(conversationId, rows, bubbles);

          if (message.type === 'result') {
            await this.#finalizeTurn({
              ...turnContext,
              result: message,
              bubbles,
            });
          }
        }
      } catch (error) {
        log.error('stream failed', {
          ...turnContext,
          error: formatError(error),
          assistantBubbleCount: bubbles.size,
        });
        if (bubbles.size === 0) {
          this.#markOutgoingFailed(outgoingModel, error);
        }
      }
    } finally {
      this.#stopTyping(conversationId);
    }
  }

  #startTyping(conversationId: string): void {
    this.#setTyping(conversationId, true);
    if (this.#typingRefreshTimers.has(conversationId)) {
      return;
    }
    this.#typingRefreshTimers.set(
      conversationId,
      setInterval(() => this.#setTyping(conversationId, true), 10_000)
    );
  }

  #stopTyping(conversationId: string): void {
    const timer = this.#typingRefreshTimers.get(conversationId);
    if (timer) {
      clearInterval(timer);
      this.#typingRefreshTimers.delete(conversationId);
    }
    this.#setTyping(conversationId, false);
  }

  #setTyping(conversationId: string, isTyping: boolean): void {
    const conversation = window.ConversationController.get(conversationId);
    if (!conversation) {
      return;
    }
    const senderId = conversation.getServiceId();
    if (!senderId) {
      return;
    }
    conversation.notifyTyping({
      isTyping,
      senderId,
      fromMe: false,
      senderDevice: 1,
    });
  }

  async #sessionFor(contact: AgentContact): Promise<LettaCodeSession> {
    const existing = this.#sessions.get(contact.agentId);
    if (existing) {
      return existing;
    }
    if (!this.#client) {
      throw new Error('Letta session is not available');
    }

    let lettaConversationId = contact.lettaConversationId;
    if (!lettaConversationId) {
      const conversation = await this.#client.conversations.create({
        agentId: contact.agentId,
      });
      lettaConversationId = conversation.id;
      this.#contacts.set(contact.conversationId, {
        ...contact,
        lettaConversationId,
      });
      await this.#persistContacts();
      log.info('Signal conversation linked to Letta conversation', {
        agentId: contact.agentId,
        lettaConversationId,
      });
    }

    const session = this.#client.resumeSession(
      lettaConversationId,
      this.#sessionOptions()
    );
    this.#sessions.set(contact.agentId, session);
    return session;
  }

  #sessionOptions() {
    return {
      permissionMode: 'unrestricted' as const,
      canUseTool: () => ({ behavior: 'allow' as const }),
    };
  }

  async #renderRows(
    conversationId: string,
    rows: ReadonlyArray<TranscriptRow>,
    bubbles: Map<string, MessageModel>
  ): Promise<void> {
    for (const row of rows) {
      if (row.kind !== 'assistant') {
        continue;
      }
      const text = row.text ?? '';
      const formatted = formatLettaMarkdown(text);
      const existing = bubbles.get(row.key);
      if (!existing) {
        bubbles.set(row.key, undefined as unknown as MessageModel);
        // Keep streamed assistant rows in transcript order.
        // oxlint-disable-next-line no-await-in-loop
        const model = await this.#injectIncoming(conversationId, text);
        if (model) {
          bubbles.set(row.key, model);
        } else {
          bubbles.delete(row.key);
        }
        continue;
      }
      if (
        (existing.get('body') ?? '') !== formatted.body ||
        !bodyRangesEqual(existing.get('bodyRanges'), formatted.bodyRanges)
      ) {
        existing.set({
          body: formatted.body,
          bodyRanges: formatted.bodyRanges,
        });
        this.#notifyChanged(conversationId, existing);
      }
    }
  }

  async #finalizeTurn({
    signalConversationId,
    signalMessageId,
    agentId,
    agentName,
    textLength,
    result,
    bubbles,
  }: {
    signalConversationId: string;
    signalMessageId: string;
    agentId: string;
    agentName: string;
    textLength: number;
    result: SDKResultMessage;
    bubbles: Map<string, MessageModel>;
  }): Promise<void> {
    const diagnostic = {
      signalConversationId,
      signalMessageId,
      agentId,
      agentName,
      textLength,
      success: result.success,
      stopReason: result.stopReason,
      errorCode: result.errorCode,
      approvalConflict: result.approvalConflict,
      recoverable: result.recoverable,
      recoveryAttempts: result.recoveryAttempts,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      lettaConversationId: result.conversationId,
      runIds: result.runIds,
      assistantBubbleCount: bubbles.size,
    };
    if (result.success) {
      this.#hideSendError();
      log.info('turn completed', diagnostic);
    } else {
      log.error('turn failed', diagnostic);
    }

    if (!result.success) {
      const message = visibleSendError(
        result.errorDetail ?? result.error ?? result.errorCode
      );
      const outgoingModel = window.MessageCache.getById(signalMessageId);
      if (bubbles.size === 0 && outgoingModel) {
        this.#markOutgoingFailed(outgoingModel, message);
      } else {
        this.#showSendError(message);
      }
    }
    await Promise.all(
      [...bubbles.values()]
        .filter(model => Boolean(model))
        .map(model => window.MessageCache.saveMessage(model))
    );
    const conversation =
      window.ConversationController.get(signalConversationId);
    if (conversation) {
      await conversation.updateLastMessage();
    }
    log.info('local turn persisted', {
      signalConversationId,
      agentId,
      assistantBubbleCount: bubbles.size,
    });
  }

  async #sendWithRecovery(
    contact: AgentContact,
    session: LettaCodeSession,
    message: SendMessage
  ): Promise<LettaCodeSession> {
    try {
      await session.send(message);
      return session;
    } catch (error) {
      if (
        isClosedCloudSession(error) &&
        this.#client &&
        contact.lettaConversationId
      ) {
        log.info('sandbox expired; rebuilding session');
        session.close();
        const next = this.#client.resumeSession(
          contact.lettaConversationId,
          this.#sessionOptions()
        );
        this.#sessions.set(contact.agentId, next);
        await next.send(message);
        return next;
      }
      throw error;
    }
  }

  async #injectIncoming(
    conversationId: string,
    body: string
  ): Promise<MessageModel | undefined> {
    const conversation = window.ConversationController.get(conversationId);
    if (!conversation) {
      log.error('injectIncoming: no conversation');
      return undefined;
    }
    const now = Date.now();
    const formatted = formatLettaMarkdown(body);
    const attributes = {
      ...generateMessageId(incrementMessageCounter()),
      conversationId: conversation.id,
      type: 'incoming' as const,
      body: formatted.body,
      bodyRanges: formatted.bodyRanges,
      sent_at: now,
      timestamp: now,
      received_at_ms: now,
      sourceServiceId: conversation.getServiceId(),
      sourceDevice: 1,
      readStatus: ReadStatus.Read,
      seenStatus: SeenStatus.Seen,
    } as unknown as MessageAttributesType;

    const model = window.MessageCache.register(new MessageModel(attributes));
    await window.MessageCache.saveMessage(model, { forceSave: true });
    await conversation.onNewMessage(model);
    await conversation.updateLastMessage();
    return model;
  }

  #markOutgoingDelivered(model: MessageModel): void {
    model.set({ errors: undefined });
    this.#stampSendState(model, SendStatus.Delivered);
  }

  #markOutgoingFailed(model: MessageModel, error?: unknown): void {
    const message =
      typeof error === 'string' && error.startsWith('Message not sent.')
        ? error
        : visibleSendError(error);
    model.set({
      errors: [
        {
          name: 'LettaSendError',
          message,
        },
      ],
    });
    this.#stampSendState(model, SendStatus.Failed);
    this.#showSendError(message);
  }

  #showSendError(message: string): void {
    const toast: AnyToast = {
      toastType: ToastType.LettaSendError,
      parameters: { message },
    };
    this.#visibleSendErrorToast = toast;
    window.reduxActions.toast.showToast(toast);
  }

  #hideSendError(): void {
    if (!this.#visibleSendErrorToast) {
      return;
    }
    window.reduxActions.toast.hideToast(this.#visibleSendErrorToast);
    this.#visibleSendErrorToast = undefined;
  }

  #stampSendState(model: MessageModel, status: SendStatus): void {
    const now = Date.now();
    const existing =
      (model.get('sendStateByConversationId') as
        | Record<string, { status: SendStatus; updatedAt?: number }>
        | undefined) ?? {};
    const updated: Record<string, { status: SendStatus; updatedAt: number }> =
      {};
    const keys = Object.keys(existing);
    const conversationId = model.get('conversationId') ?? '';
    if (keys.length === 0 && conversationId) {
      keys.push(conversationId);
    }
    for (const key of keys) {
      updated[key] = { status, updatedAt: now };
    }
    model.set({ sendStateByConversationId: updated });
    drop(window.MessageCache.saveMessage(model));
    if (conversationId) {
      this.#notifyChanged(conversationId, model);
    }
  }

  #notifyChanged(conversationId: string, model: MessageModel): void {
    window.reduxActions.conversations.messageChanged(
      model.id,
      conversationId,
      model.attributes
    );
  }
}

export const lettaService = new LettaService();
export type LettaServiceType = typeof lettaService;
