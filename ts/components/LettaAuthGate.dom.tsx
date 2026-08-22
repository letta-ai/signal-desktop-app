// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState, type JSX } from 'react';

import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { Spinner } from './Spinner.dom.tsx';
import type { LettaAuthStatus } from '../types/LettaAuth.std.ts';
import { isLettaAuthStatus } from '../types/LettaAuth.std.ts';

function formatExpiry(expiresAt: number): string {
  const remainingMinutes = Math.max(
    0,
    Math.round((expiresAt - Date.now()) / 60000)
  );
  if (remainingMinutes === 1) {
    return 'Code expires in 1 minute.';
  }
  return `Code expires in ${remainingMinutes} minutes.`;
}

export function LettaAuthGate({
  children,
}: {
  children: JSX.Element;
}): JSX.Element {
  const [status, setStatus] = useState<LettaAuthStatus>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const loaded = await window.IPC.getLettaAuthStatus();
        if (!disposed && isLettaAuthStatus(loaded)) {
          setStatus(loaded);
        }
      } catch {
        // Status stays undefined; the loading view remains until an event
        // arrives.
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

  const onSignIn = useCallback(() => {
    void window.IPC.startLettaLogin();
  }, []);

  const onCancel = useCallback(() => {
    void window.IPC.cancelLettaLogin();
  }, []);

  const onOpenBrowser = useCallback((url: string) => {
    // The main process validates the URL origin before opening it.
    void window.IPC.openLettaAuthorization(url);
  }, []);

  // Signed in (or refreshing an existing session): render the inbox unchanged.
  if (
    status &&
    (status.state === 'signed-in' || status.state === 'refreshing')
  ) {
    return children;
  }

  if (!status) {
    return (
      <div className="LettaAuthGate">
        <Spinner
          ariaLabel="Loading"
          direction="on-background"
          svgSize="normal"
        />
      </div>
    );
  }

  const copyCode = async (code: string) => {
    try {
      await window.navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail; the code is still visible on screen.
    }
  };

  if (status.state === 'authorizing') {
    return (
      <div className="LettaAuthGate">
        <h1 className="LettaAuthGate__title">Signal Letta</h1>
        <p className="LettaAuthGate__subtitle">
          Finish signing in through your browser
        </p>
        <div
          className="LettaAuthGate__code"
          aria-label={`Your sign-in code is ${status.userCode}`}
        >
          {status.userCode}
        </div>
        <div className="LettaAuthGate__expiry">
          {formatExpiry(status.expiresAt)}
        </div>
        <div className="LettaAuthGate__actions">
          <AxoButton.Root
            onClick={() => onOpenBrowser(status.verificationUriComplete)}
            size="lg"
            variant="strong-secondary"
          >
            Open browser again
          </AxoButton.Root>
          <AxoButton.Root
            onClick={() => void copyCode(status.userCode)}
            size="lg"
            variant="strong-secondary"
          >
            {copied ? 'Copied' : 'Copy code'}
          </AxoButton.Root>
          <AxoButton.Root
            onClick={onCancel}
            size="lg"
            variant="subtle-secondary"
          >
            Cancel
          </AxoButton.Root>
        </div>
      </div>
    );
  }

  if (status.state === 'error') {
    return (
      <div className="LettaAuthGate">
        <h1 className="LettaAuthGate__title">Signal Letta</h1>
        <p
          className={
            status.recoverable
              ? 'LettaAuthGate__subtitle'
              : 'LettaAuthGate__subtitle LettaAuthGate__subtitle--error'
          }
          role={status.recoverable ? 'status' : 'alert'}
        >
          {status.message}
        </p>
        <div className="LettaAuthGate__actions">
          <AxoButton.Root onClick={onSignIn} size="lg" variant="strong-primary">
            Try again
          </AxoButton.Root>
        </div>
      </div>
    );
  }

  // Signed out.
  return (
    <div className="LettaAuthGate">
      <h1 className="LettaAuthGate__title">Signal Letta</h1>
      <p className="LettaAuthGate__subtitle">
        Chat with your persistent Letta agents.
      </p>
      {!status.secureStorageAvailable ? (
        <p className="LettaAuthGate__subtitle--error" role="alert">
          Secure credential storage is unavailable on this system, so sign in is
          disabled.
        </p>
      ) : null}
      <div className="LettaAuthGate__actions">
        <AxoButton.Root
          disabled={!status.secureStorageAvailable}
          onClick={onSignIn}
          size="lg"
          variant="strong-primary"
        >
          Sign in with Letta
        </AxoButton.Root>
      </div>
    </div>
  );
}
