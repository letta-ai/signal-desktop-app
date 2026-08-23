// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, type JSX } from 'react';
import { useSelector } from 'react-redux';
import { Inbox } from '../../components/Inbox.dom.tsx';
import { SmartCustomizingPreferredReactionsModal } from './CustomizingPreferredReactionsModal.preload.tsx';
import { getIsCustomizingPreferredReactions } from '../selectors/preferredReactions.std.ts';
import type { SmartNavTabsProps } from './NavTabs.preload.tsx';
import { SmartNavTabs } from './NavTabs.preload.tsx';
import { SmartStoriesTab } from './StoriesTab.preload.tsx';
import { SmartCallsTab } from './CallsTab.preload.tsx';
import { useItemsActions } from '../ducks/items.preload.ts';
import { getNavTabsCollapsed } from '../selectors/items.dom.ts';
import { SmartChatsTab } from './ChatsTab.preload.tsx';
import { SmartPreferences } from './Preferences.preload.tsx';
import { LettaAuthGate } from '../../components/LettaAuthGate.dom.tsx';
import { LETTA_MODE } from '../../util/lettaMode.std.ts';

function renderChatsTab() {
  return <SmartChatsTab />;
}

function renderCallsTab() {
  return <SmartCallsTab />;
}

function renderCustomizingPreferredReactionsModal() {
  return <SmartCustomizingPreferredReactionsModal />;
}

function renderNavTabs(props: SmartNavTabsProps) {
  return <SmartNavTabs {...props} />;
}

function renderStoriesTab() {
  return <SmartStoriesTab />;
}

function renderSettingsTab() {
  return <SmartPreferences />;
}

export const SmartInbox = memo(function SmartInbox(): JSX.Element {
  const isCustomizingPreferredReactions = useSelector(
    getIsCustomizingPreferredReactions
  );
  const navTabsCollapsed = useSelector(getNavTabsCollapsed);

  const { toggleNavTabsCollapse } = useItemsActions();

  const inbox = (
    <Inbox
      isCustomizingPreferredReactions={isCustomizingPreferredReactions}
      navTabsCollapsed={navTabsCollapsed}
      onToggleNavTabsCollapse={toggleNavTabsCollapse}
      renderChatsTab={renderChatsTab}
      renderCallsTab={renderCallsTab}
      renderCustomizingPreferredReactionsModal={
        renderCustomizingPreferredReactionsModal
      }
      renderNavTabs={renderNavTabs}
      renderStoriesTab={renderStoriesTab}
      renderSettingsTab={renderSettingsTab}
    />
  );

  // While signed out, the auth gate owns the whole window instead of showing
  // an empty or broken inbox.
  if (LETTA_MODE) {
    return <LettaAuthGate>{inbox}</LettaAuthGate>;
  }

  return inbox;
});
