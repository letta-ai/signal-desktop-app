// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState, type JSX } from 'react';

import { AxoButton } from '../axo/AxoButton.dom.tsx';
import type { LettaAuthStatus } from '../types/LettaAuth.std.ts';
import { isLettaAuthStatus } from '../types/LettaAuth.std.ts';

export function PreferencesLettaAccount(): JSX.Element {
  const [status, setStatus] = useState<LettaAuthStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const loaded = await window.IPC.getLettaAuthStatus();
        if (!disposed) {
          setStatus(loaded);
        }
      } catch (loadError) {
        if (!disposed) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Could not load Letta account status.'
          );
        }
      }
    };
    void load();
    const onStatus = (_event: unknown, next: unknown) => {
      if (isLettaAuthStatus(next)) {
        setStatus(next);
      }
    };
    window.Whisper.events.on('letta-auth-status', onStatus);
    return () => {
      disposed = true;
      window.Whisper.events.off('letta-auth-status', onStatus);
    };
  }, []);

  const onLogout = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      setStatus(await window.IPC.logoutLetta());
    } catch (logoutError) {
      setError(
        logoutError instanceof Error
          ? logoutError.message
          : 'Could not log out of Letta.'
      );
    } finally {
      setPending(false);
    }
  }, []);

  const source =
    status?.state === 'signed-in' || status?.state === 'refreshing'
      ? status.source
      : undefined;

  let description: string;
  if (!status || !source) {
    description = 'Not signed in to Letta.';
  } else if (source === 'environment') {
    description =
      'Authentication comes from the LETTA_API_KEY environment variable. Remove it to use Letta sign in instead.';
  } else {
    description = 'Signed in through the browser.';
  }

  return (
    <>
      <div className="Preferences__description" role="status">
        {description}
      </div>
      <div className="PreferencesTranscription__remove-key">
        <AxoButton.Root
          disabled={source !== 'oauth' || pending}
          onClick={onLogout}
          pending={pending}
          size="md"
          variant="subtle-secondary"
        >
          Log out of Letta
        </AxoButton.Root>
      </div>
      {source === 'environment' ? (
        <div className="Preferences__description">
          Logging out is disabled while an environment credential is active.
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
    </>
  );
}
