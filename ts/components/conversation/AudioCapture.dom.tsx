// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, type JSX } from 'react';

import type { ShowToastAction } from '../../state/ducks/toast.preload.ts';
import type { AttachmentDraftType } from '../../types/Attachment.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import { ToastType } from '../../types/Toast.dom.tsx';
import { LETTA_MODE } from '../../util/lettaMode.std.ts';
import { NavTab, SettingsPage } from '../../types/Nav.std.ts';
import {
  useStartRecordingShortcut,
  useKeyboardShortcuts,
} from '../../hooks/useKeyboardShortcuts.dom.tsx';
import { AxoIconButton } from '../../axo/AxoIconButton.dom.tsx';

export type PropsType = {
  conversationId: string;
  draftAttachments: ReadonlyArray<AttachmentDraftType>;
  i18n: LocalizerType;
  startRecording: (id: string) => unknown;
  warmupRecording: () => void;
  showToast: ShowToastAction;
};

export function AudioCapture({
  conversationId,
  draftAttachments,
  i18n,
  startRecording,
  warmupRecording,
  showToast,
}: PropsType): JSX.Element {
  const recordConversation = useCallback(
    () => startRecording(conversationId),
    [conversationId, startRecording]
  );
  const startRecordingShortcut = useStartRecordingShortcut(recordConversation);
  useKeyboardShortcuts(startRecordingShortcut);

  const handleClick = useCallback(() => {
    const record = () => {
      if (draftAttachments.length) {
        showToast({ toastType: ToastType.VoiceNoteMustBeTheOnlyAttachment });
      } else {
        startRecording(conversationId);
      }
    };
    if (!LETTA_MODE) {
      record();
      return;
    }
    void (async () => {
      try {
        const config = await window.IPC.getLettaTranscriptionConfig();
        const selected = config.providers.find(
          provider => provider.id === config.provider
        );
        if (!config.secureStorageAvailable || !selected?.configured) {
          showToast({
            toastType: ToastType.LettaSendError,
            parameters: {
              message:
                'Add a key for the selected transcription service in Settings before sending a voice memo.',
            },
          });
          window.reduxActions.nav.changeLocation({
            tab: NavTab.Settings,
            details: { page: SettingsPage.Transcription },
          });
          return;
        }
      } catch {
        showToast({
          toastType: ToastType.LettaSendError,
          parameters: {
            message:
              'Add a key for the selected transcription service in Settings before sending a voice memo.',
          },
        });
        window.reduxActions.nav.changeLocation({
          tab: NavTab.Settings,
          details: { page: SettingsPage.Transcription },
        });
        return;
      }
      record();
    })();
  }, [conversationId, draftAttachments, showToast, startRecording]);

  const handleWarmup = useCallback(() => {
    warmupRecording();
  }, [warmupRecording]);

  return (
    <div className="AudioCapture">
      <AxoIconButton.Root
        symbol="mic"
        variant="implied-secondary"
        size="md"
        label={i18n('icu:voiceRecording--start')}
        onClick={handleClick}
        onMouseEnter={handleWarmup}
        onFocus={handleWarmup}
        tooltip={false}
      />
    </div>
  );
}
