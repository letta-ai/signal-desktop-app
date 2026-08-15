// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { Select } from './Select.dom.tsx';
import { SettingsRow } from './PreferencesUtil.dom.tsx';
import type { LettaTranscriptionConfig } from '../types/LettaTranscription.std.ts';
import { isLettaTranscriptionProvider } from '../types/LettaTranscription.std.ts';

function settingsError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes('TRANSCRIPTION_SECURE_STORAGE_UNAVAILABLE')) {
    return 'Secure key storage is not available on this system.';
  }
  if (detail.includes('TRANSCRIPTION_KEY_INVALID')) {
    return 'Enter a valid API key.';
  }
  return 'Could not update the transcription settings.';
}

export function PreferencesTranscription(): JSX.Element {
  const [config, setConfig] = useState<LettaTranscriptionConfig>();
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await window.IPC.getLettaTranscriptionConfig());
    } catch (loadError) {
      setError(settingsError(loadError));
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const selected = useMemo(
    () => config?.providers.find(provider => provider.id === config.provider),
    [config]
  );

  const runUpdate = useCallback(
    async (
      update: () => Promise<LettaTranscriptionConfig>,
      successMessage: string
    ) => {
      setPending(true);
      setError(undefined);
      setStatus(undefined);
      try {
        setConfig(await update());
        setApiKey('');
        setStatus(successMessage);
      } catch (updateError) {
        setError(settingsError(updateError));
      } finally {
        setPending(false);
      }
    },
    []
  );

  const onProviderChange = useCallback(
    (value: string) => {
      if (!isLettaTranscriptionProvider(value)) {
        return;
      }
      void runUpdate(
        () => window.IPC.setLettaTranscriptionProvider(value),
        `${config?.providers.find(provider => provider.id === value)?.name ?? value} selected.`
      );
    },
    [config, runUpdate]
  );

  const onSave = useCallback(() => {
    const provider = config?.provider;
    if (!provider) {
      return;
    }
    void runUpdate(
      () => window.IPC.setLettaTranscriptionKey(provider, apiKey),
      `${selected?.name ?? provider} key saved.`
    );
  }, [apiKey, config?.provider, runUpdate, selected?.name]);

  const onRemove = useCallback(() => {
    const provider = config?.provider;
    if (!provider) {
      return;
    }
    void runUpdate(
      () => window.IPC.clearLettaTranscriptionKey(provider),
      `${selected?.name ?? provider} key removed.`
    );
  }, [config?.provider, runUpdate, selected?.name]);

  const providerOptions =
    config?.providers.map(provider => ({
      text: `${provider.name}${provider.configured ? ' — key saved' : ''}`,
      value: provider.id,
    })) ?? [];
  const selectedProvider = config?.provider;

  return (
    <>
      <SettingsRow title="Service">
        <div className="PreferencesTranscription__service">
          <label
            className="PreferencesTranscription__key-label"
            htmlFor="PreferencesTranscription__service-select"
          >
            Transcription service
          </label>
          <Select
            ariaLabel="Transcription service"
            disabled={!config || pending}
            id="PreferencesTranscription__service-select"
            moduleClassName="PreferencesTranscription__service-select"
            onChange={onProviderChange}
            options={providerOptions}
            value={selectedProvider}
          />
          <div className="Preferences__description">
            Signal Letta sends each outgoing voice memo to this service.
          </div>
          {selected ? (
            <div className="PreferencesTranscription__model">
              <div>Model</div>
              <div className="Preferences__description">{selected.model}</div>
            </div>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow title="API key">
        <div className="PreferencesTranscription__key">
          <label
            className="PreferencesTranscription__key-label"
            htmlFor="PreferencesTranscription__key-input"
          >
            {selected?.name ?? 'Provider'} API key
          </label>
          <div className="PreferencesTranscription__key-controls">
            <input
              autoComplete="off"
              aria-label={`${selected?.name ?? 'Provider'} API key`}
              className="PreferencesTranscription__key-input"
              disabled={!config?.secureStorageAvailable || pending}
              id="PreferencesTranscription__key-input"
              onChange={event => setApiKey(event.currentTarget.value)}
              placeholder={
                selected?.configured ? 'Replace saved key' : 'Enter API key'
              }
              spellCheck={false}
              type="password"
              value={apiKey}
            />
            <AxoButton.Root
              disabled={!apiKey.trim() || !config?.secureStorageAvailable}
              pending={pending}
              onClick={onSave}
              size="md"
              variant="strong-primary"
            >
              Save
            </AxoButton.Root>
          </div>
          <div className="Preferences__description">
            {selected?.configured
              ? 'A key is saved for this service.'
              : 'No key is saved for this service.'}
          </div>
          {!config?.secureStorageAvailable ? (
            <div className="Preferences__description Preferences__description--error">
              Secure key storage is not available. Signal Letta will not save a
              key.
            </div>
          ) : null}
          {status ? (
            <div className="Preferences__description" role="status">
              {status}
            </div>
          ) : null}
          {error ? (
            <div
              className="Preferences__description Preferences__description--error"
              role="alert"
            >
              {error}
            </div>
          ) : null}
          {selected?.configured ? (
            <div className="PreferencesTranscription__remove-key">
              <AxoButton.Root
                disabled={pending}
                onClick={onRemove}
                size="md"
                variant="subtle-destructive"
              >
                Remove saved key
              </AxoButton.Root>
            </div>
          ) : null}
        </div>
      </SettingsRow>
    </>
  );
}
