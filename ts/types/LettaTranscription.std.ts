// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export const LETTA_TRANSCRIPTION_PROVIDERS = [
  'openai',
  'groq',
  'deepgram',
] as const;

export type LettaTranscriptionProvider =
  (typeof LETTA_TRANSCRIPTION_PROVIDERS)[number];

export type LettaTranscriptionProviderStatus = Readonly<{
  id: LettaTranscriptionProvider;
  name: string;
  model: string;
  configured: boolean;
}>;

export type LettaTranscriptionConfig = Readonly<{
  provider: LettaTranscriptionProvider;
  providers: ReadonlyArray<LettaTranscriptionProviderStatus>;
  secureStorageAvailable: boolean;
}>;

export type LettaTranscriptionAudio = Readonly<{
  data: Uint8Array<ArrayBuffer>;
  contentType: string;
}>;

export function isLettaTranscriptionProvider(
  value: unknown
): value is LettaTranscriptionProvider {
  return LETTA_TRANSCRIPTION_PROVIDERS.some(provider => provider === value);
}
