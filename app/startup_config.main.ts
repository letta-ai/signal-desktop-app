// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { app } from 'electron';

import { packageJson } from '../ts/util/packageJson.main.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import * as GlobalErrors from './global_errors.main.ts';
import { LETTA_APP_NAME, LETTA_MODE } from '../ts/util/lettaMode.std.ts';

const log = createLogger('startup_config');

GlobalErrors.addHandler();

// Set umask early on in the process lifecycle to ensure file permissions are
// set such that only we have read access to our files
process.umask(0o077);

// Rename before any safeStorage use. Electron's macOS keychain item is
// derived from app.getName(), and the stock name ("Signal") collides with
// the installed production app's "Signal Safe Storage" item.
if (LETTA_MODE) {
  app.setName(LETTA_APP_NAME);
  log.info('Letta mode: renamed app to isolate Keychain', {
    name: app.getName(),
  });
}

export const AUMID = LETTA_MODE
  ? 'ai.letta.signal-desktop'
  : `org.whispersystems.${packageJson.name}`;
log.info('Set Windows Application User Model ID (AUMID)', {
  AUMID,
});
app.setAppUserModelId(AUMID);
