<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Signal Agent SDK Demo

This repository demonstrates how to connect the [Letta Agent SDK](https://github.com/letta-ai/letta-agent-sdk) to an existing desktop application shell. It keeps Signal Desktop's familiar contact list, conversations, composer, message history, attachments, typing indicators, and retry interface while using Letta agents and conversations behind them.

This is an integration demo. It is not a Signal client for communicating over the Signal network, an official Signal release, or a starter architecture for a new chat application. If you want a purpose-built Agent SDK client, see the [Agent SDK mobile example](https://github.com/letta-ai/agent-sdk-mobile-app).

## What it demonstrates

- Representing Letta agents as contacts in an existing application's data model.
- Giving each contact a persistent Letta conversation.
- Connecting an existing send action to `session.send()`.
- Folding `session.stream()` through `createTranscriptAccumulator()` and projecting assistant rows into native message objects.
- Reusing the host application's optimistic sends, local history, typing state, failure state, and retry action.
- Sending image attachments as Agent SDK multimodal content.
- Transcribing outgoing voice memos before sending their text to an agent.
- Loading agent profile pictures from MemFS into the host application's avatar system.

The integration is intentionally shaped around Signal Desktop's existing boundaries. Signal-specific identity seeding, contact records, Redux actions, and database writes are adapter code for this demo, not requirements of the Agent SDK.

## Run locally

Signal Desktop currently requires Node.js 24.17.0 and pnpm 11.5.2.

```bash
nvm install
nvm use
pnpm install
pnpm generate
LETTA_API_KEY=sk-let-... pnpm start
```

`LETTA_API_KEY` is used for both agent discovery and agent turns by default. To run turns with a separate credential, set `LETTA_RUNTIME_API_KEY` as well.

Optional settings:

- `LETTA_MODE=0` runs the upstream Signal behavior instead of the demo integration.
- `COMPANY_LETTA_API_KEY` and `DEVELOPERS_API_KEY` are accepted as local credential fallbacks.
- Voice transcription providers and their keys are configured inside the app under **Settings → Transcription**.

The Agent SDK is vendored at version 0.7.1 so a fresh clone uses the exact SDK version this demo was tested against.

## How messages flow

1. Signal creates and stores the outgoing message using its normal composer and message model.
2. The Letta adapter creates a Letta conversation on the first send, then resumes that conversation through the portable Agent SDK client.
3. Text and supported attachments are passed to `session.send()`.
4. Stream messages are applied to the SDK transcript accumulator.
5. Assistant rows are inserted as incoming Signal messages and updated as their text grows.
6. SDK or transcription failures use Signal's existing failed-send state and **Retry Send** action.

The main integration lives in [`ts/services/letta.preload.ts`](ts/services/letta.preload.ts). Detailed implementation notes are in [`LETTA_FORK.md`](LETTA_FORK.md).

## Demo boundaries

- Letta mode does not link a Signal account or authenticate with Signal's service.
- Reasoning, tool-call, and tool-result rows are not rendered.
- The demo uses `permissionMode: 'unrestricted'` and an allow-all `canUseTool` callback because it has no approval interface. Agents used with this demo can run their available tools without asking in the UI.
- Images are limited to PNG, JPEG, GIF, and WebP.
- Voice memo audio is sent to the transcription provider selected by the user. Only the returned text is sent to the Letta agent.
- The first remote-history import is limited to 100 messages.
- This repository has not been prepared for independent distribution under Signal's name or trademarks.

## Upstream and license

This repository is a fork of [Signal Desktop](https://github.com/signalapp/Signal-Desktop). Signal Desktop is Copyright 2013-2024 Signal Messenger, LLC and licensed under the GNU AGPLv3. See [`LICENSE`](LICENSE) and [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md).

Letta and Signal are separate projects. This demo is maintained by Letta and is not an official Signal release.
