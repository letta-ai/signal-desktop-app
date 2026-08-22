// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Narrow bridge between the preload-only Letta service and the main-process
// auth service. This module is intentionally NOT part of the renderer-facing
// window.IPC contract: only letta.preload.ts may import it, and it must never
// be re-exported through renderer-visible state.

import { ipcRenderer as ipc } from 'electron';

import type { LettaAuthStatus } from '../types/LettaAuth.std.ts';

export type LettaCredential =
  | { source: 'environment'; apiKey: string }
  | { source: 'oauth'; apiKey: string };

async function getCurrentCredential(): Promise<LettaCredential | undefined> {
  const value = (await ipc.invoke('letta-auth:get-credential')) as
    | LettaCredential
    | undefined;
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (
    (value.source !== 'environment' && value.source !== 'oauth') ||
    typeof value.apiKey !== 'string' ||
    !value.apiKey
  ) {
    return undefined;
  }
  return value;
}

function onStatusChanged(
  callback: (status: LettaAuthStatus) => void
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    status: LettaAuthStatus
  ) => {
    callback(status);
  };
  ipc.on('letta-auth:status-changed', listener);
  return () => {
    ipc.off('letta-auth:status-changed', listener);
  };
}

export const lettaAuthBridge = {
  getCurrentCredential,
  onStatusChanged,
};
