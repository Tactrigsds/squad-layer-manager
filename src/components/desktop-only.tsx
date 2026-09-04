import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import { tr } from '@/systems/messages.client'
import * as SiteMode from '@/systems/site-mode.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import PhoneTabBar from './phone-tab-bar'

const PAGE_TITLES: [prefix: string, title: () => string][] = [
	['/commands', () => tr.text(APP_Msgs.navCommands())],
	['/filters', () => tr.text(APP_Msgs.navFilters())],
	['/history', () => tr.text(APP_Msgs.navHistory())],
	['/tutorials', () => tr.text(APP_Msgs.navTutorials())],
	['/settings', () => tr.text(APP_Msgs.navSettings())],
	['/about', () => tr.text(APP_Msgs.about())],
]

// What a phone sees in place of a page the phone layout does not cover. The tab bar stays, so the dashboard is one
// tap away.
export default function DesktopOnly() {
	const navigate = TSR.useNavigate()
	const pathname = TSR.useRouterState({ select: (s) => s.location.pathname })
	const title = PAGE_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1]() ?? tr.text(APP_Msgs.productName())
	const selectedServerId = Zus.useStore(SquadServerClient.SelectedServerStore, (s) => s.selectedServerId)

	const goToServer = (tab?: SquadServerClient.DashboardTab) => {
		if (selectedServerId) void navigate({ to: '/servers/$serverId', params: { serverId: selectedServerId }, search: { tab } })
		else void navigate({ to: '/servers' })
	}

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
				<Icons.AppWindow className="size-7 text-text-3" />
				<div className="font-bold text-base">{tr.text(APP_Msgs.desktopOnlyTitle(title))}</div>
				<div className="max-w-[280px] text-text-3 leading-relaxed">{tr.text(APP_Msgs.desktopOnlyBlurb())}</div>
				<Button variant="primary" className="mt-1.5 h-9 px-4" onClick={() => SiteMode.setSiteMode('desktop')}>
					<Icons.Monitor />
					{tr.text(APP_Msgs.switchToDesktopSite())}
				</Button>
				<button type="button" className="text-xs text-text-3 underline underline-offset-2" onClick={() => goToServer()}>
					{tr.text(APP_Msgs.backToServer())}
				</button>
			</div>
			<PhoneTabBar active={null} onSelect={goToServer} />
		</div>
	)
}
