# Signal Desktop × Letta — fork notes

This fork replaces Signal's protocol backend with the **Letta Agent SDK**. The
Signal UI is preserved, but there is exactly **one** conversation and it is
bound to a Letta agent's *default conversation*. You type in Signal's composer,
the text goes to the agent via the SDK, and the agent's streamed reply renders
as an incoming message — a single-threaded, "one contact" feel like chat.letta.com,
with Signal's look.

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

- `LETTA_MODE=0` — disable the fork, run stock Signal.
- `LETTA_AGENT_MODEL=anthropic/claude-opus-4-8` — model for the agent created on
  first launch (default shown).

On first launch the app creates a hidden Letta agent and stores its id in
Signal's local storage (`lettaAgentId`); every later launch resumes the same
agent's default conversation, so the thread persists.

## What changed

### New files
- `ts/util/lettaMode.preload.ts` — `LETTA_MODE` flag, API key, fixed local
  identity UUIDs, storage keys.
- `ts/services/letta.preload.ts` — the whole integration: SDK client/session
  lifecycle, agent-id persistence, boot identity seeding, single-conversation
  bootstrap + auto-select, the send turn-loop, and streamed incoming-bubble
  injection.
- `.npmrc` — `verify-deps-before-run=false` (the local-tarball SDK dependency
  changes pnpm's allowBuilds set, which otherwise blocks scripts).

### Edited files
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
    outgoing message is persisted and its text forwarded to
    `window.lettaService.sendText(model)` instead of the Signal transport job.
    The optimistic outgoing bubble is untouched.
- `ts/window.d.ts` — declares `window.lettaService`.
- `.oxlint/rules/enforceFileSuffix.mjs` — categorizes `@letta-ai/letta-agent-sdk`
  as an std package for the file-suffix lint rule.

## How a message round-trips

1. **Send** — composer → `enqueueMessageForSend` builds + inserts the optimistic
   outgoing bubble (unchanged), then the seam calls `lettaService.sendText()`.
   The service `session.send(text)`s to the agent's default conversation and
   marks the outgoing bubble delivered.
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
- Integration lives in the **preload** bundle — that's where Signal's whole
  React/Redux app runs, with `window.reduxActions`, `ConversationController`,
  `MessageCache`, `storage`, plus Node + DOM.
- SDK entry is the portable **`@letta-ai/letta-agent-sdk/client`** (a
  self-contained, dependency-free bundle) with `backend: 'cloud'` and
  `webSocketAuth: 'query'` (a browser WebSocket can't send an Authorization
  header, so the token goes in the query string).
- SDK version is **0.7.1**, vendored as a relative tarball under `vendor/` and
  referenced from `package.json` as `file:vendor/letta-ai-letta-agent-sdk-0.7.1.tgz`
  so the fork installs from a clone without depending on the npm publish
  (0.7.1 is still inside the registry's minimum-release-age window). To move to
  the npm package later: `pnpm add -w @letta-ai/letta-agent-sdk@^0.7.1` and
  delete `vendor/`.

## Known limitations / v1 scope cuts
- Text only — no attachments, quotes, edits, or reactions forwarded to the agent.
- Reasoning and tool-call/tool-result stream events are ignored (not rendered).
- No approval flow (`canUseTool` unset); an agent turn that stops on a required
  approval would hang the stream. Keep the agent's tools non-approval-gated.
- No history import on first boot (the thread starts empty locally even if the
  agent's default conversation already has messages server-side).
- The left-pane conversation list UI is left intact; the fork just guarantees a
  single visible conversation rather than removing the list component.
- Outgoing status is marked "delivered" optimistically when `send()` hands off.
