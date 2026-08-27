// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState, type JSX } from 'react';

import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { SettingsRow } from './PreferencesUtil.dom.tsx';
import type {
  LettaAuthStatus,
  LettaCredentialCheck,
} from '../types/LettaAuth.std.ts';
import {
  isLettaAuthStatus,
  isLettaCredentialCheck,
  readLettaAuthStatus,
} from '../types/LettaAuth.std.ts';

function connectionCopy(
  check: LettaCredentialCheck | 'checking' | undefined
): string | undefined {
  if (check === 'checking') {
    return 'Checking this key with Letta…';
  }
  if (!check) {
    return undefined;
  }
  switch (check.state) {
    case 'ok':
      return 'Letta accepted this key.';
    case 'invalid':
      return 'Letta rejected this key.';
    case 'unreachable':
      return 'Could not reach Letta to check this key.';
    case 'signed-out':
      return undefined;
    default:
      return undefined;
  }
}

export function PreferencesLettaAccount(): JSX.Element {
  const [status, setStatus] = useState<LettaAuthStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [check, setCheck] = useState<LettaCredentialCheck | 'checking'>();

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const loaded = await window.IPC.getLettaAuthStatus();
        if (!disposed && isLettaAuthStatus(loaded)) {
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
    const onStatus = (...args: Array<unknown>) => {
      const parsed = readLettaAuthStatus(...args);
      if (parsed) {
        setStatus(parsed);
      }
    };
    window.Whisper.events.on('letta-auth-status', onStatus);
    return () => {
      disposed = true;
      window.Whisper.events.off('letta-auth-status', onStatus);
    };
  }, []);

  useEffect(() => {
    const signedIn =
      status?.state === 'signed-in' || status?.state === 'refreshing';
    if (!signedIn) {
      setCheck(undefined);
      return;
    }
    let disposed = false;
    setCheck('checking');
    const run = async () => {
      try {
        const result = await window.IPC.checkLettaCredential();
        if (!disposed && isLettaCredentialCheck(result)) {
          setCheck(result);
        }
      } catch {
        if (!disposed) {
          setCheck({ state: 'unreachable' });
        }
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, [status]);

  const onSignIn = useCallback(() => {
    setError(undefined);
    const run = async () => {
      try {
        const parsed = readLettaAuthStatus(await window.IPC.startLettaLogin());
        if (parsed) {
          setStatus(parsed);
        }
      } catch (signInError) {
        setError(
          signInError instanceof Error
            ? signInError.message
            : 'Could not start Letta sign in.'
        );
      }
    };
    void run();
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

  let title = 'Not signed in';
  let description = 'Sign in with Letta to chat with your agents.';
  if (source === 'environment') {
    title = 'Signed in with an environment API key';
    description =
      'The app reads LETTA_API_KEY when it starts. Remove that variable and restart to sign in with a Letta account.';
  } else if (source === 'oauth') {
    title = 'Signed in with a Letta account';
    description = 'You signed in through the browser.';
  } else if (status?.state === 'authorizing') {
    title = 'Waiting for browser approval';
    description =
      'Finish signing in in your browser. Keep Signal Letta open — approval returns here automatically.';
  }

  const connection = connectionCopy(check);
  const connectionIsError =
    check && check !== 'checking' && check.state === 'invalid';
  const canSignIn =
    !source && status?.state !== 'authorizing' && status != null;
  const signInDisabled =
    pending ||
    (status?.state === 'signed-out' && !status.secureStorageAvailable);

  return (
    <SettingsRow title="Account">
      <div className="PreferencesLettaAccount">
        <div className="PreferencesLettaAccount__title">{title}</div>
        <div className="Preferences__description">{description}</div>
        {connection ? (
          <div
            className={
              connectionIsError
                ? 'Preferences__description Preferences__description--error'
                : 'Preferences__description'
            }
            role="status"
          >
            {connection}
          </div>
        ) : null}
        {status?.state === 'signed-out' && !status.secureStorageAvailable ? (
          <div
            className="Preferences__description Preferences__description--error"
            role="alert"
          >
            Secure credential storage is unavailable on this system, so sign in
            is disabled.
          </div>
        ) : null}
        {canSignIn ? (
          <div className="PreferencesLettaAccount__actions">
            <AxoButton.Root
              disabled={signInDisabled}
              onClick={onSignIn}
              size="md"
              variant="strong-primary"
            >
              Sign in with Letta
            </AxoButton.Root>
          </div>
        ) : null}
        {source === 'oauth' ? (
          <>
            <div className="PreferencesLettaAccount__actions">
              <AxoButton.Root
                disabled={pending}
                onClick={onLogout}
                pending={pending}
                size="md"
                variant="subtle-secondary"
              >
                Log out of Letta
              </AxoButton.Root>
            </div>
            <div className="Preferences__description">
              Log out keeps local chats on this device.
            </div>
          </>
        ) : null}
        {error ? (
          <div
            className="Preferences__description Preferences__description--error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}
