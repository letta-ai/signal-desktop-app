// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';

import type { LocalizerType } from '../types/I18N.std.ts';
import type { NavTabPanelProps } from './NavTabs.dom.tsx';
import { WhatsNewLink } from './WhatsNewLink.dom.tsx';
import type { UnreadStats } from '../util/countUnreadStats.std.ts';
import type { SmartConversationViewProps } from '../state/smart/ConversationView.preload.tsx';
import { tw } from '../axo/tw.dom.tsx';
import { LETTA_MODE } from '../util/lettaMode.std.ts';

export type ChatsTabProps = Readonly<{
  otherTabsUnreadStats: UnreadStats;
  i18n: LocalizerType;
  isStaging: boolean;
  hasPendingUpdate: boolean;
  hasFailedStorySends: boolean;
  navTabsCollapsed: boolean;
  onToggleNavTabsCollapse: (navTabsCollapsed: boolean) => void;
  renderConversationView: (props: SmartConversationViewProps) => JSX.Element;
  renderLeftPane: (props: NavTabPanelProps) => JSX.Element;
  renderMiniPlayer: (options: { shouldFlow: boolean }) => JSX.Element;
  selectedConversationId: string | undefined;
  showWhatsNewModal: () => unknown;
}>;

export function ChatsTab({
  otherTabsUnreadStats,
  i18n,
  isStaging,
  hasPendingUpdate,
  hasFailedStorySends,
  navTabsCollapsed,
  onToggleNavTabsCollapse,
  renderConversationView,
  renderLeftPane,
  renderMiniPlayer,
  selectedConversationId,
  showWhatsNewModal,
}: ChatsTabProps): JSX.Element {
  let welcome = i18n('icu:welcomeToSignal');
  if (LETTA_MODE) {
    welcome = 'THIS IS SIGNAL LETTA';
  } else if (isStaging) {
    welcome = 'THIS IS A STAGING DESKTOP';
  }

  return (
    <>
      <div id="LeftPane">
        {renderLeftPane({
          otherTabsUnreadStats,
          collapsed: navTabsCollapsed,
          hasPendingUpdate,
          hasFailedStorySends,
          onToggleCollapse: onToggleNavTabsCollapse,
        })}
      </div>
      <div className="Inbox__conversation-stack">
        <div id="toast" />
        {selectedConversationId ? (
          <div
            // Use `key` to force the tree to fully re-mount
            key={selectedConversationId}
            className="Inbox__conversation"
            id={`conversation-${selectedConversationId}`}
          >
            {renderConversationView({ selectedConversationId })}
          </div>
        ) : (
          <div className="Inbox__no-conversation-open">
            {renderMiniPlayer({ shouldFlow: false })}
            <div className="module-splash-screen__logo module-splash-screen__logo--96" />
            <h3 className="Inbox__welcome">{welcome}</h3>
            <p className="Inbox__whatsnew">
              {LETTA_MODE ? (
                'Chat with your Letta agents in Signal'
              ) : (
                <WhatsNewLink
                  i18n={i18n}
                  showWhatsNewModal={showWhatsNewModal}
                />
              )}
            </p>
            <div className="Inbox__padding" />
            <div className={tw('absolute bottom-0 p-5 text-secondary')}>
              {i18n('icu:signalNonProfit')}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
