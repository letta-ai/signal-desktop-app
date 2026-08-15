// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Main-process Letta fork flags. Keep this file free of preload-only imports
// so startup can rename the app before Electron safeStorage touches Keychain.

const environment: Record<string, string | undefined> =
  typeof process === 'undefined' ? {} : process.env;

export const LETTA_MODE: boolean = environment.LETTA_MODE !== '0';

export const LETTA_APP_NAME = 'Signal Letta';

function firstEnv(...names: Array<string>): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

// Agent discovery runs as the signed-in user.
export const LETTA_API_KEY: string | undefined = firstEnv(
  'LETTA_API_KEY',
  'DEVELOPERS_API_KEY',
  'COMPANY_LETTA_API_KEY'
);

// Agent turns can use a service credential for Cloud sandbox execution.
export const LETTA_RUNTIME_API_KEY: string | undefined = firstEnv(
  'LETTA_RUNTIME_API_KEY',
  'DEVELOPERS_API_KEY',
  'LETTA_API_KEY',
  'COMPANY_LETTA_API_KEY'
);

// Fixed, valid ACI-format UUID for our local identity. Never sent anywhere.
export const LETTA_OUR_ACI = 'a1b2c3d4-1111-4111-8111-111111111111';

// DNS namespace UUID. Combined with an agent id to make a stable ACI.
export const LETTA_ACI_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Legacy single-peer ACI from v1. Hidden after we list real agents.
export const LETTA_LEGACY_PEER_ACI = 'b2c3d4e5-2222-4222-8222-222222222222';
