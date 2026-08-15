// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcMain as ipc, safeStorage } from 'electron';

import { userConfig } from '../../app/user_config.main.ts';
import { createLogger } from '../logging/log.std.ts';
import {
  isLettaTranscriptionProvider,
  LETTA_TRANSCRIPTION_PROVIDERS,
  type LettaTranscriptionAudio,
  type LettaTranscriptionConfig,
  type LettaTranscriptionProvider,
} from '../types/LettaTranscription.std.ts';
import { LETTA_MODE } from '../util/lettaMode.std.ts';
import {
  LETTA_TRANSCRIPTION_PROVIDER_DEFINITIONS,
  LettaTranscriptionProviderError,
  transcribeAudioWithProvider,
} from './lettaTranscriptionProvider.std.ts';

const log = createLogger('lettaTranscription');
const CONFIG_KEY = 'lettaTranscription';
const MAX_API_KEY_LENGTH = 4096;

type StoredConfig = Readonly<{
  provider: LettaTranscriptionProvider;
  encryptedKeys: Partial<Record<LettaTranscriptionProvider, string>>;
  safeStorageBackend?: string;
}>;

function currentSafeStorageBackend(): string | undefined {
  return process.platform === 'linux'
    ? safeStorage.getSelectedStorageBackend()
    : undefined;
}

function secureStorageAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    currentSafeStorageBackend() !== 'basic_text'
  );
}

function readConfig(): StoredConfig {
  const value = userConfig.get(CONFIG_KEY);
  if (!value || typeof value !== 'object') {
    return { provider: 'openai', encryptedKeys: {} };
  }
  const candidate = value as {
    provider?: unknown;
    encryptedKeys?: unknown;
    safeStorageBackend?: unknown;
  };
  const encryptedKeys: Partial<Record<LettaTranscriptionProvider, string>> = {};
  if (candidate.encryptedKeys && typeof candidate.encryptedKeys === 'object') {
    for (const provider of LETTA_TRANSCRIPTION_PROVIDERS) {
      const encrypted = (candidate.encryptedKeys as Record<string, unknown>)[
        provider
      ];
      if (typeof encrypted === 'string' && encrypted.length > 0) {
        encryptedKeys[provider] = encrypted;
      }
    }
  }
  return {
    provider: isLettaTranscriptionProvider(candidate.provider)
      ? candidate.provider
      : 'openai',
    encryptedKeys,
    safeStorageBackend:
      typeof candidate.safeStorageBackend === 'string'
        ? candidate.safeStorageBackend
        : undefined,
  };
}

function writeConfig(config: StoredConfig): void {
  userConfig.set(CONFIG_KEY, config);
}

function configStatus(): LettaTranscriptionConfig {
  const config = readConfig();
  return {
    provider: config.provider,
    providers: LETTA_TRANSCRIPTION_PROVIDERS.map(provider => ({
      id: provider,
      ...LETTA_TRANSCRIPTION_PROVIDER_DEFINITIONS[provider],
      configured: Boolean(config.encryptedKeys[provider]),
    })),
    secureStorageAvailable: secureStorageAvailable(),
  };
}

function assertSecureStorage(config?: StoredConfig): void {
  if (!secureStorageAvailable()) {
    throw new Error('TRANSCRIPTION_SECURE_STORAGE_UNAVAILABLE');
  }
  const previousBackend = config?.safeStorageBackend;
  const currentBackend = currentSafeStorageBackend();
  if (previousBackend && previousBackend !== currentBackend) {
    throw new Error('TRANSCRIPTION_SECURE_STORAGE_UNAVAILABLE');
  }
}

function setProvider(value: unknown): LettaTranscriptionConfig {
  if (!isLettaTranscriptionProvider(value)) {
    throw new Error('TRANSCRIPTION_PROVIDER_INVALID');
  }
  const config = readConfig();
  writeConfig({ ...config, provider: value });
  log.info('selected transcription provider', { provider: value });
  return configStatus();
}

function setKey(value: unknown): LettaTranscriptionConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('TRANSCRIPTION_KEY_INVALID');
  }
  const { provider, apiKey } = value as {
    provider?: unknown;
    apiKey?: unknown;
  };
  if (
    !isLettaTranscriptionProvider(provider) ||
    typeof apiKey !== 'string' ||
    apiKey.trim().length === 0 ||
    apiKey.trim().length > MAX_API_KEY_LENGTH
  ) {
    throw new Error('TRANSCRIPTION_KEY_INVALID');
  }
  const config = readConfig();
  assertSecureStorage();
  const safeStorageBackend = currentSafeStorageBackend();
  const encryptedKeys =
    config.safeStorageBackend &&
    config.safeStorageBackend !== safeStorageBackend
      ? {}
      : config.encryptedKeys;
  const encrypted = safeStorage.encryptString(apiKey.trim()).toString('hex');
  writeConfig({
    ...config,
    provider,
    encryptedKeys: { ...encryptedKeys, [provider]: encrypted },
    safeStorageBackend,
  });
  log.info('saved transcription key', { provider });
  return configStatus();
}

function clearKey(value: unknown): LettaTranscriptionConfig {
  if (!isLettaTranscriptionProvider(value)) {
    throw new Error('TRANSCRIPTION_PROVIDER_INVALID');
  }
  const config = readConfig();
  const encryptedKeys = { ...config.encryptedKeys };
  delete encryptedKeys[value];
  writeConfig({
    ...config,
    encryptedKeys,
    safeStorageBackend:
      Object.keys(encryptedKeys).length > 0
        ? config.safeStorageBackend
        : undefined,
  });
  log.info('removed transcription key', { provider: value });
  return configStatus();
}

function clearConfiguration(): void {
  userConfig.set(CONFIG_KEY, undefined);
  log.info('removed transcription configuration');
}

function decryptSelectedKey(config: StoredConfig): string {
  assertSecureStorage(config);
  const encrypted = config.encryptedKeys[config.provider];
  if (!encrypted) {
    throw new Error(`TRANSCRIPTION_KEY_MISSING: ${config.provider}`);
  }
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'hex'));
  } catch {
    throw new Error('TRANSCRIPTION_KEY_UNREADABLE');
  }
}

async function transcribe(value: unknown): Promise<string> {
  if (!value || typeof value !== 'object') {
    throw new Error('TRANSCRIPTION_AUDIO_INVALID');
  }
  const { data, contentType } = value as Partial<LettaTranscriptionAudio>;
  if (
    !(data instanceof Uint8Array) ||
    typeof contentType !== 'string' ||
    !contentType.startsWith('audio/')
  ) {
    throw new Error('TRANSCRIPTION_AUDIO_INVALID');
  }

  const config = readConfig();
  const apiKey = decryptSelectedKey(config);
  log.info('voice memo transcription started', {
    provider: config.provider,
    bytes: data.byteLength,
  });
  try {
    const text = await transcribeAudioWithProvider({
      provider: config.provider,
      apiKey,
      data,
      contentType,
    });
    log.info('voice memo transcription completed', {
      provider: config.provider,
      bytes: data.byteLength,
    });
    return text;
  } catch (error) {
    if (error instanceof LettaTranscriptionProviderError) {
      log.error('voice memo transcription failed', {
        provider: error.provider,
        code: error.code,
        statusCode: error.statusCode,
        bytes: data.byteLength,
      });
    } else {
      log.error('voice memo transcription failed', {
        provider: config.provider,
        bytes: data.byteLength,
      });
    }
    throw error;
  }
}

let installed = false;

export function installLettaTranscriptionService(): void {
  if (!LETTA_MODE || installed) {
    return;
  }
  installed = true;
  ipc.handle('letta-transcription:get-config', configStatus);
  ipc.handle('letta-transcription:set-provider', (_event, value) =>
    setProvider(value)
  );
  ipc.handle('letta-transcription:set-key', (_event, value) => setKey(value));
  ipc.handle('letta-transcription:clear-key', (_event, value) =>
    clearKey(value)
  );
  ipc.handle('letta-transcription:clear-configuration', clearConfiguration);
  ipc.handle('letta-transcription:transcribe', (_event, value) =>
    transcribe(value)
  );
}
