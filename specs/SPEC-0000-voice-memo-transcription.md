---
id: SPEC-0000
title: Voice memo transcription
status: implemented
---

# Voice memo transcription

Signal Letta must transcribe an outgoing voice memo before it sends the text to the selected Letta agent. The original voice memo stays in local message history.

## User flow

1. The user records and sends a voice memo.
2. Signal Letta saves the outgoing voice memo in local history.
3. The main process reads the selected transcription provider and its encrypted API key.
4. The main process sends the audio to the selected provider.
5. Signal Letta sends the returned text to the Letta agent.
6. A transcription or agent error marks the outgoing voice memo as failed. The user can retry the same message.

## Settings

The Letta-only settings navigation contains a **Transcription** page. The page supports OpenAI, Groq, and Deepgram.

The page shows the selected provider and whether each provider has a saved key. It never shows a saved key. The user can save, replace, or remove the key for the selected provider.

The following provider models are fixed in this version:

- OpenAI: `gpt-4o-transcribe`
- Groq: `whisper-large-v3-turbo`
- Deepgram: `nova-3`

## Security and privacy

- The renderer sends a new key to the main process through Electron IPC.
- The main process encrypts each key with Electron `safeStorage`.
- Signal Letta rejects key storage when `safeStorage` is unavailable or uses the Linux `basic_text` backend.
- The renamed `Signal Letta` app identity keeps its macOS Keychain item separate from Signal.
- The main process never returns a plaintext key to the renderer.
- Logs contain provider names, status codes, and byte counts. Logs do not contain keys, audio, or transcripts.
- Reset local data removes the transcription provider and all encrypted transcription keys.

## Provider contract

- The OpenAI and Groq adapters send `multipart/form-data` requests.
- The Deepgram adapter sends the recorded audio as the request body with its MIME type.
- Every adapter returns trimmed text.
- Every adapter rejects empty text.
- The common upload limit is 25 MB.
- Each request has a 60-second timeout.
- A request uses only the selected provider. This version has no provider fallback.

## Acceptance criteria

- [x] The Transcription page appears only when `LETTA_MODE` is enabled.
- [x] The user can select OpenAI, Groq, or Deepgram.
- [x] The user can save, replace, and remove one key for each provider.
- [x] The renderer can read key presence but cannot read a saved key.
- [x] Key storage fails when secure encryption is unavailable.
- [x] An outgoing voice memo stays visible and playable in local history.
- [x] A successful transcription sends only the transcript to the Letta agent.
- [x] A failed transcription marks the voice memo as failed and supports manual retry.
- [x] Reset local data removes all transcription configuration.
- [x] Provider contract tests use mock HTTP responses and no credentials.
- [x] Stock Signal behavior does not change when `LETTA_MODE=0`.
- [x] Type checks, lint checks, and the production build pass.
- [x] A real-app test proves the settings flow and the outgoing voice memo flow.

## Non-goals

- Do not send voice memo audio to the Letta agent.
- Do not add live transcription while the user records.
- Do not add timestamps, diarization, language selection, or model selection.
- Do not add automatic provider fallback.
- Do not change incoming audio behavior.
- Do not change stock Signal settings or transport behavior.

## Dependencies

None.

## Implementation links

- `ts/services/lettaTranscriptionProvider.std.ts`
- `ts/services/lettaTranscription.main.ts`
- `ts/services/letta.preload.ts`
- `ts/components/PreferencesTranscription.dom.tsx`
- `ts/test-node/services/lettaTranscriptionProvider_test.std.ts`

## Review record

The source review traced voice recording through `audioRecorder.preload.ts`, `ConversationModel.sendMessage`, and `letta.preload.ts`. The review also checked the main-process `safeStorage` setup and official provider request formats.

The real-app test selected all three providers and completed the save and remove flow for each provider. A saved Groq key appeared in `config.json` only as encrypted data. The renderer showed key presence and did not contain the saved key.

The storage-recovery test seeded ciphertext from an unavailable encryption backend. Saving a replacement key discarded the unreadable ciphertext and used the current backend. Removing the final key also removed the stored backend marker.

The voice test recorded synthetic microphone audio and sent it through Groq. The outgoing voice memo stayed playable in local history. The Letta turn contained transcript text and no image. The selected agent returned a response. A separate test used an invalid key, showed the authentication error, and then completed the same message through **Retry Send** after the key was replaced.

The reset-cleanup IPC removed the transcription configuration. Eight provider contract tests, type checks, focused lint checks, stylelint, and the production build passed.
