import * as Icons from 'lucide-react'
import React from 'react'

import * as APP_Msgs from '@/messages/app.messages'
import { tr } from '@/systems/messages.client'
import type * as SquadServerClient from '@/systems/squad-server.client'

type Screen = SquadServerClient.DashboardTab

const SCREENS: { value: Screen; icon: React.ComponentType<{ className?: string }>; label: () => string }[] = [
	{ value: 'matches', icon: Icons.History, label: () => tr.text(APP_Msgs.phoneMatches()) },
	{ value: 'queue', icon: Icons.List, label: () => tr.text(APP_Msgs.phoneQueue()) },
	{ value: 'teams', icon: Icons.Users, label: () => tr.text(APP_Msgs.phoneTeams()) },
	{ value: 'activity', icon: Icons.LayoutList, label: () => tr.text(APP_Msgs.phoneActivity()) },
]

// the phone layout's bottom tab bar. `active` is null on a page that is not the dashboard, where every tab leads
// back to it.
export default function PhoneTabBar(props: {
	active: Screen | null
	badges?: Partial<Record<Screen, number>>
	onSelect: (screen: Screen) => void
}) {
	return (
		<nav className="grid shrink-0 grid-cols-4 h-(--tabbar-h) bg-panel-hi border-t border-line shadow-[inset_0_1px_0_var(--line-soft)] pb-[env(safe-area-inset-bottom)] box-content">
			{SCREENS.map((s) => (
				<button
					key={s.value}
					type="button"
					data-state={props.active === s.value ? 'active' : 'inactive'}
					onClick={() => props.onSelect(s.value)}
					className="relative flex flex-col items-center justify-center gap-1 text-2xs font-semibold text-text-3 data-[state=active]:text-pri-hi data-[state=active]:shadow-[inset_0_2px_0_var(--pri)]"
				>
					<s.icon className="size-6" />
					{props.badges?.[s.value] !== undefined && (
						<span className="absolute top-2 left-[calc(50%+8px)] grid min-w-4 h-4 place-items-center rounded-full bg-[#414144] px-1 font-mono text-2xs text-text">
							{props.badges[s.value]}
						</span>
					)}
					<span>{s.label()}</span>
				</button>
			))}
		</nav>
	)
}
