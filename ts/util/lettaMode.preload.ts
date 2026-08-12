// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Letta fork configuration.
//
// This build replaces Signal's protocol backend with the Letta Agent SDK. The
// app runs against a single, always-present conversation that maps to a Letta
// agent's default conversation, preserving Signal's single-thread / multi-user
// "feel" while every message actually round-trips through a stateful agent.

// Enabled by default; set LETTA_MODE=0 to run stock Signal behavior.
export const LETTA_MODE: boolean =
  typeof process !== 'undefined' && process.env?.LETTA_MODE === '0'
    ? false
    : true;

// Cloud API key for the Letta Agent SDK. Read from the environment in
// development. Sends fail with a visible error if this is unset.
export const LETTA_API_KEY: string | undefined =
  typeof process !== 'undefined' ? process.env?.LETTA_API_KEY : undefined;

// Optional model + persona overrides used when creating the agent the first
// time. After first boot the agent id is persisted and reused.
export const LETTA_AGENT_MODEL: string =
  (typeof process !== 'undefined' && process.env?.LETTA_AGENT_MODEL) ||
  'anthropic/claude-opus-4-8';

// Fixed, valid ACI-format UUIDs. These are local identity anchors only; they
// are never sent anywhere. "Our" ACI satisfies Signal's registration gate; the
// "peer" ACI owns the single Letta conversation and every incoming agent reply.
export const LETTA_OUR_ACI = 'a1b2c3d4-1111-4111-8111-111111111111';
export const LETTA_PEER_ACI = 'b2c3d4e5-2222-4222-8222-222222222222';

// Display name for the agent conversation shown in the left pane / header.
export const LETTA_PEER_NAME = 'Letta';

// window.storage keys.
export const LETTA_AGENT_ID_KEY = 'lettaAgentId';
