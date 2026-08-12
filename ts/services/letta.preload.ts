// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Letta integration service.
//
// Replaces Signal's protocol send/receive with the Letta Agent SDK. The whole
// app talks to a single conversation that is bound to a Letta agent's default
// conversation:
//
//   * boot: seed a fabricated (but valid) local identity so Signal opens
//     straight into the inbox without account linking, then guarantee exactly
//     one visible conversation and auto-select it.
//   * send: outgoing composer text is forwarded to `session.send()` instead of
//     the Signal transport (the optimistic outgoing bubble is untouched).
//   * receive: the agent's streamed reply is injected as an incoming message
//     model so it renders as a normal incoming bubble, updated live as tokens
//     stream in.

import {
  LettaAgentClient,
  CloudManagedSandboxExpiredError,
  createTranscriptAccumulator,
} from '@letta-ai/letta-agent-sdk/client';
import type { TranscriptRow } from '@letta-ai/letta-agent-sdk/client';

import { createLogger } from '../logging/log.std.ts';
import { drop } from '../util/drop.std.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { incrementMessageCounter } from '../util/incrementMessageCounter.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { DataWriter } from '../sql/Client.preload.ts';
import * as Registration from '../util/registration.preload.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import {
  LETTA_MODE,
  LETTA_API_KEY,
  LETTA_AGENT_MODEL,
  LETTA_OUR_ACI,
  LETTA_PEER_ACI,
  LETTA_PEER_NAME,
  LETTA_AGENT_ID_KEY,
} from '../util/lettaMode.preload.ts';

const log = createLogger('letta');

// `lettaAgentId` is not part of Signal's typed storage key union; use a loose
// accessor for our own keys.
const untypedStorage = itemStorage as unknown as {
  get(key: string): unknown;
  put(key: string, value: unknown): Promise<void>;
};

// The SDK's portable client + session are structurally typed here to avoid
// depending on the exact exported names, which live behind the /client entry.
type LettaSession = {
  send(message: string): Promise<void>;
  stream(): AsyncGenerator<LettaStreamMessage>;
  close?(): void;
};

type LettaStreamMessage =
  | { type: 'assistant'; content: string; uuid: string; otid?: string | null }
  | {
      type: 'result';
      success: boolean;
      result?: string;
      error?: string;
      errorCode?: string;
      errorDetail?: string;
    }
  | { type: string; [key: string]: unknown };

class LettaService {
  #client: LettaAgentClient | undefined;
  #session: LettaSession | undefined;
  #agentId: string | undefined;
  #conversationId: string | undefined;
  #initPromise: Promise<void> | undefined;

  // Serializes turns: the SDK's stream() drains one shared queue, so only one
  // turn may run at a time. Sends that arrive mid-turn are chained.
  #turnChain: Promise<unknown> = Promise.resolve();

  isEnabled(): boolean {
    return LETTA_MODE;
  }

  // ---- Boot: identity + conversation ------------------------------------

  // Seed a valid-but-fabricated registration so Signal's startup gate opens the
  // inbox. Critically we do NOT seed auth credentials (number_id/password), so
  // Signal's SocketManager never has credentials and never attempts to
  // authenticate against a server — no 401, no unlink. Idempotent per boot.
  async seedIdentity(): Promise<void> {
    if (!LETTA_MODE) {
      return;
    }
    try {
      if (itemStorage.user.getAci() !== LETTA_OUR_ACI) {
        await itemStorage.user.setAciAndDeviceId(
          LETTA_OUR_ACI as AciString,
          1
        );
      }
      if (!Registration.everDone()) {
        await Registration.markDone();
      }
      // Never divert to backup import.
      if (itemStorage.get('backupDownloadPath')) {
        await itemStorage.remove('backupDownloadPath');
      }
      log.info('seedIdentity: local Letta identity ready');
    } catch (error) {
      log.error('seedIdentity failed', error);
    }
  }

  // Ensure exactly one visible conversation (the Letta agent thread) exists and
  // is selected. Everything else is hidden from the left pane (active_at null).
  async bootstrapConversation(): Promise<void> {
    if (!LETTA_MODE) {
      return;
    }
    try {
      const conversation =
        await window.ConversationController.getOrCreateAndWait(
          LETTA_PEER_ACI,
          'private',
          {
            active_at: Date.now(),
            profileSharing: true,
            name: LETTA_PEER_NAME,
            systemGivenName: LETTA_PEER_NAME,
          }
        );
      this.#conversationId = conversation.id;

      const ourId = window.ConversationController.getOurConversationId();
      for (const other of window.ConversationController.getAll()) {
        if (other.id === conversation.id || other.id === ourId) {
          continue;
        }
        if (other.get('active_at') != null || other.get('isPinned')) {
          other.set({ active_at: null, isPinned: false });
          drop(DataWriter.updateConversation(other.attributes));
        }
      }

      // Select it and switch to the Chats view.
      window.reduxActions.conversations.showConversation({
        conversationId: conversation.id,
        switchToAssociatedView: true,
      });
      log.info('bootstrapConversation: single conversation ready');
    } catch (error) {
      log.error('bootstrapConversation failed', error);
    }
  }

  // ---- SDK lifecycle -----------------------------------------------------

  initialize(): Promise<void> {
    if (!LETTA_MODE) {
      return Promise.resolve();
    }
    this.#initPromise ??= this.#doInitialize();
    return this.#initPromise;
  }

  async #doInitialize(): Promise<void> {
    if (!LETTA_API_KEY) {
      log.error(
        'LETTA_API_KEY is not set — the agent will be unreachable. ' +
          'Set it in the environment before launching.'
      );
      return;
    }

    this.#client = new LettaAgentClient({
      backend: 'cloud',
      apiKey: LETTA_API_KEY,
      // A browser WebSocket cannot send an Authorization header, so the SDK
      // must pass the token as a query parameter.
      webSocketAuth: 'query',
      // Agent turns can be long; the default (120s) is too tight.
      requestTimeoutMs: 600_000,
    } as ConstructorParameters<typeof LettaAgentClient>[0]);

    this.#agentId = await this.#resolveAgentId();
    if (!this.#agentId) {
      return;
    }

    // A non-`conv-` id resumes the agent's DEFAULT conversation — the one
    // durable thread this app is built around. Never createSession().
    this.#session = this.#client.resumeSession(
      this.#agentId
    ) as unknown as LettaSession;
    log.info('letta service initialized', { agentId: this.#agentId });
  }

  async #resolveAgentId(): Promise<string | undefined> {
    const stored = untypedStorage.get(LETTA_AGENT_ID_KEY) as string | undefined;
    if (stored) {
      return stored;
    }
    if (!this.#client) {
      return undefined;
    }
    try {
      const agentId = await this.#client.createAgent({
        name: 'Signal Letta',
        model: LETTA_AGENT_MODEL,
        hidden: true,
        memory: [
          {
            label: 'persona',
            value:
              'You are a warm, concise conversational companion chatting ' +
              'inside a Signal-style messenger. Reply naturally, like a text ' +
              'message.',
          },
        ],
      });
      await untypedStorage.put(LETTA_AGENT_ID_KEY, agentId);
      log.info('created new Letta agent', { agentId });
      return agentId;
    } catch (error) {
      log.error('createAgent failed', error);
      return undefined;
    }
  }

  // ---- Send --------------------------------------------------------------

  // Called from the send seam. Forwards the outgoing text to the agent and
  // schedules the streamed reply. Resolves once the turn is enqueued (not when
  // it completes) so the composer stays responsive.
  sendText(outgoingModel: MessageModel): Promise<void> {
    if (!LETTA_MODE) {
      return Promise.resolve();
    }
    const body = String(outgoingModel.get('body') ?? '').trim();
    this.#turnChain = this.#turnChain
      .then(() => this.#runTurn(body, outgoingModel))
      .catch(error => {
        log.error('turn failed', error);
      });
    return Promise.resolve();
  }

  async #runTurn(text: string, outgoingModel: MessageModel): Promise<void> {
    await this.initialize();
    if (!this.#session) {
      this.#markOutgoingFailed(outgoingModel);
      await this.#injectIncoming(
        '⚠️ Letta is not configured (missing LETTA_API_KEY).'
      );
      return;
    }

    if (!text) {
      this.#markOutgoingDelivered(outgoingModel);
      return;
    }

    try {
      await this.#sendWithRecovery(text);
    } catch (error) {
      log.error('session.send failed', error);
      this.#markOutgoingFailed(outgoingModel);
      await this.#injectIncoming(`⚠️ Failed to reach Letta: ${error}`);
      return;
    }

    this.#markOutgoingDelivered(outgoingModel);

    // Let the SDK's accumulator assemble streamed fragments into stable rows
    // (typed-by-family merging, otid/uuid keying, replay suppression). We map
    // each assistant row to one incoming bubble, keyed by the row's stable key.
    const transcript = createTranscriptAccumulator();
    const bubbles = new Map<string, MessageModel>();
    try {
      for await (const message of this.#session.stream()) {
        const rows = transcript.apply(message as Parameters<typeof transcript.apply>[0]);
        await this.#renderRows(rows, bubbles);

        if ((message as { type?: string }).type === 'result') {
          this.#finalizeTurn(
            message as {
              success: boolean;
              error?: string;
              errorCode?: string;
              errorDetail?: string;
            },
            bubbles
          );
        }
      }
    } catch (error) {
      log.error('stream failed', error);
      if (bubbles.size === 0) {
        await this.#injectIncoming(`⚠️ Stream error: ${error}`);
      }
    }
  }

  // Reconcile the accumulator's current rows against the on-screen bubbles.
  // v1 renders assistant rows only (reasoning / tool activity are ignored).
  async #renderRows(
    rows: readonly TranscriptRow[],
    bubbles: Map<string, MessageModel>
  ): Promise<void> {
    for (const row of rows) {
      if (row.kind !== 'assistant') {
        continue;
      }
      const text = row.text ?? '';
      const existing = bubbles.get(row.key);
      if (!existing) {
        // Reserve the slot synchronously so a burst of rows can't double-create.
        bubbles.set(row.key, undefined as unknown as MessageModel);
        const model = await this.#injectIncoming(text);
        if (model) {
          bubbles.set(row.key, model);
        } else {
          bubbles.delete(row.key);
        }
        continue;
      }
      if (String(existing.get('body') ?? '') !== text) {
        existing.set({ body: text });
        this.#notifyChanged(existing);
      }
    }
  }

  #finalizeTurn(
    result: {
      success: boolean;
      error?: string;
      errorCode?: string;
      errorDetail?: string;
    },
    bubbles: Map<string, MessageModel>
  ): void {
    if (!result.success && bubbles.size === 0) {
      const detail =
        result.errorDetail ||
        result.error ||
        result.errorCode ||
        'unknown error';
      drop(this.#injectIncoming(`⚠️ Agent error: ${detail}`));
    }
    // Persist the final state of every rendered bubble.
    for (const model of bubbles.values()) {
      if (model) {
        drop(window.MessageCache.saveMessage(model, { forceSave: true }));
      }
    }
  }

  async #sendWithRecovery(text: string): Promise<void> {
    if (!this.#session) {
      return;
    }
    try {
      await this.#session.send(text);
    } catch (error) {
      // A cold cloud sandbox can expire between turns; rebuild the session once.
      if (
        error instanceof CloudManagedSandboxExpiredError &&
        this.#client &&
        this.#agentId
      ) {
        log.info('sandbox expired; rebuilding session');
        this.#session = this.#client.resumeSession(
          this.#agentId
        ) as unknown as LettaSession;
        await this.#session.send(text);
        return;
      }
      throw error;
    }
  }

  // ---- Receive (incoming bubble injection) -------------------------------

  async #injectIncoming(body: string): Promise<MessageModel | undefined> {
    const conversation = this.#getConversation();
    if (!conversation) {
      log.error('injectIncoming: no conversation');
      return undefined;
    }
    const now = Date.now();
    const attributes = {
      ...generateMessageId(incrementMessageCounter()),
      conversationId: conversation.id,
      type: 'incoming' as const,
      body,
      sent_at: now,
      timestamp: now,
      received_at_ms: now,
      // Must equal the conversation's serviceId or it renders as an outgoing
      // (self) bubble.
      sourceServiceId: LETTA_PEER_ACI,
      readStatus: ReadStatus.Read,
      seenStatus: SeenStatus.Seen,
    } as unknown as MessageAttributesType;

    const model = window.MessageCache.register(new MessageModel(attributes));
    await window.MessageCache.saveMessage(model, { forceSave: true });
    await conversation.onNewMessage(model);
    return model;
  }

  // ---- Outgoing status ---------------------------------------------------

  #markOutgoingDelivered(model: MessageModel): void {
    this.#stampSendState(model, SendStatus.Delivered);
  }

  #markOutgoingFailed(model: MessageModel): void {
    this.#stampSendState(model, SendStatus.Failed);
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
    if (keys.length === 0 && this.#conversationId) {
      keys.push(this.#conversationId);
    }
    for (const key of keys) {
      updated[key] = { status, updatedAt: now };
    }
    model.set({ sendStateByConversationId: updated });
    drop(window.MessageCache.saveMessage(model, { forceSave: true }));
    this.#notifyChanged(model);
  }

  // ---- Helpers -----------------------------------------------------------

  #getConversation(): ConversationModel | undefined {
    if (!this.#conversationId) {
      return undefined;
    }
    return window.ConversationController.get(this.#conversationId);
  }

  #notifyChanged(model: MessageModel): void {
    if (!this.#conversationId) {
      return;
    }
    window.reduxActions.conversations.messageChanged(
      model.id,
      this.#conversationId,
      model.attributes
    );
  }
}

export const lettaService = new LettaService();
