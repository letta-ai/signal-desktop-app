# Signal Desktop × Letta fork notes

This fork is a demo of connecting the **Letta Agent SDK** to an existing desktop
application shell. All Letta agents are available under **New chat** and search.
The left pane shows only agents with a started chat. Each contact uses a dedicated
persistent Letta conversation. Replies stream in as incoming bubbles.

Everything is gated behind `LETTA_MODE` (on by default; set `LETTA_MODE=0` to run
stock Signal).

## Run it

```bash
# 1. install (already done if you cloned + installed)
pnpm install

# 2. build the renderer/preload/main bundles
pnpm generate

# 3. launch with your Letta Cloud API key in the environment
LETTA_API_KEY=sk-let-... pnpm start
```

Optional env:

- `LETTA_MODE=0` disables the demo integration and runs the upstream Signal behavior.
- `LETTA_RUNTIME_API_KEY` uses a separate credential for agent turns.
- `COMPANY_LETTA_API_KEY` and `DEVELOPERS_API_KEY` remain available as local
  credential fallbacks.

The app caches agent contacts and their dedicated Letta conversation IDs in
Signal's isolated local profile. Later launches restore the same contacts and
conversations before refreshing the agent list.

## What changed

### New files

- `ts/util/lettaMode.std.ts` contains the `LETTA_MODE` flag, API key lookup,
  fixed local identity UUIDs, and the main-process app name. It is used to rename
  the Electron app before `safeStorage` so macOS Keychain never asks for
  production Signal's `Signal Safe Storage` item.
- `ts/services/letta.preload.ts` — SDK client and session lifecycle, boot identity
  seeding, cached agent contacts, dedicated conversations, remote history import,
  MemFS avatars, typing state, the send turn-loop, and streamed incoming bubbles.
- `.npmrc` — `verify-deps-before-run=false` (the local-tarball SDK dependency
  changes pnpm's allowBuilds set, which otherwise blocks scripts).

### Edited files

- `app/startup_config.main.ts` — under `LETTA_MODE`, `app.setName('Signal Letta')`
  before any `safeStorage` use so the Keychain item is `Signal Letta Safe Storage`.
- `app/main.main.ts` — skip Electron `safeStorage` for the SQL key under
  `LETTA_MODE` (plaintext key stays in the isolated `Signal-development` profile).
- `ts/background.preload.ts`
  - Seeds a valid-but-fabricated local identity (`setAciAndDeviceId` + mark
    registration done) at the top of `start()` so the startup gate opens the
    inbox **without** Signal account linking. Crucially it seeds **no** auth
    credentials (`number_id`/`password`), so Signal's `SocketManager` never has
    credentials and never authenticates against a server — no 401, no
    auto-unlink.
  - Startup gate (`~:1560`) forced to the `openInbox()` branch under `LETTA_MODE`,
    then kicks off `lettaService.initialize()` + `bootstrapConversation()`.
  - `unlinkAndDisconnect()` is a no-op under `LETTA_MODE` (belt-and-braces: a
    stray auth error must never wipe the fake identity).
- `ts/models/conversations.preload.ts`
  - Send seam in `enqueueMessageForSend` (`~:4392`): under `LETTA_MODE` the
    outgoing message is persisted and its text and image attachments are
    forwarded to `window.lettaService.sendText(model)` instead of the Signal
    transport job.
    The optimistic outgoing bubble is untouched.
- `ts/window.d.ts` — declares `window.lettaService`.
- `.oxlint/rules/enforceFileSuffix.mjs` — categorizes `@letta-ai/letta-agent-sdk`
  as an std package for the file-suffix lint rule.

## How a message round-trips

1. **Send** — composer → `enqueueMessageForSend` builds and inserts the outgoing
   bubble, then the seam calls `lettaService.sendText()`. On the first send, the
   adapter creates a conversation through `client.conversations.create()` and
   resumes it with `client.resumeSession()`. It marks success as delivered. It
   uses Signal's native failed-send status and retry action for failures. It does
   not create an incoming error bubble.
2. **Receive** — the service iterates `session.stream()` and folds each message
   through the SDK's `createTranscriptAccumulator()` (the canonical way to turn
   streamed fragments into stable rows — typed-by-family merging, otid/uuid
   keying, replay suppression, per the agent-sdk `messages` docs). Each
   `assistant` row maps to one incoming message model (`sourceServiceId` = the
   agent peer ACI), injected via `MessageCache.register` +
   `conversation.onNewMessage` on first sight and updated in place
   (`messageChanged`) as its text grows. Turns are serialized (the SDK's
   `stream()` drains one shared queue).

## Architecture choices

- Integration lives in the **preload** bundle because that is where Signal's
  React/Redux app exposes `window.reduxActions`, `ConversationController`,
  `MessageCache`, storage, Node, and the DOM.
- All Agent SDK values and types come from the portable
  **`@letta-ai/letta-agent-sdk/client`** entry. The client uses `backend: 'cloud'`
  and `webSocketAuth: 'query'` because a browser WebSocket cannot send an
  Authorization header.
- Agent and conversation management use the SDK's `agents` and `conversations`
  namespaces. The profile-picture endpoint remains a direct API call because the
  portable SDK does not expose it.
- SDK version is **0.7.1**, vendored as a relative tarball under `vendor/` and
  referenced from `package.json` as `file:vendor/letta-ai-letta-agent-sdk-0.7.1.tgz`
  so a fresh clone uses the exact SDK version tested with this demo. To move to
  the npm package later: `pnpm add -w @letta-ai/letta-agent-sdk@^0.7.1` and
  delete `vendor/`.

## Known limitations / v1 scope cuts

- PNG, JPEG, GIF, and WebP images are forwarded with an optional caption. Other
  attachments, quotes, edits, and reactions are not forwarded.
- Reasoning and tool-call/tool-result stream events are ignored (not rendered).
- The demo has no approval interface. Sessions use `permissionMode: 'unrestricted'`
  and an allow-all `canUseTool` callback, so available tools can run without asking
  in the UI.
- Remote user and assistant messages are imported when a dedicated conversation
  has no local history. The first import is limited to 100 remote messages.
- The left pane shows chats with a message, saved draft, or dedicated Letta
  conversation. Unused contacts remain available under **New chat** and search.
- A send is marked delivered after `session.send()` succeeds. A failed send keeps
  one outgoing bubble with Signal's native `Send failed` and `Retry Send` UI.
