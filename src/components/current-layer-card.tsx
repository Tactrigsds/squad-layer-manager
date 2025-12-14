import { getTeamsDisplay } from '@/components/teams-display.tsx'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import * as DH from '@/lib/display-helpers.ts'
import * as Typo from '@/lib/typography'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client.ts'
import { useLoggedInUser } from '@/systems.client/users.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import BalanceTriggerAlert from './balance-trigger-alert.tsx'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import { ServerUnreachable } from './server-offline-display.tsx'
import { Timer } from './timer.tsx'

export function CurrentLayerCardContent() {
	const serverLayerStatusRes = SquadServerClient.useLayersStatus()
	const serverInfoStatusRes = SquadServerClient.useServerInfoRes()
	const serverRolling = !!SquadServerClient.useServerRolling()
	const updatesToSquadServerDisabled = Zus.useStore(ServerSettingsClient.Store, s => s.saved?.updatesToSquadServerDisabled)

	if (serverInfoStatusRes.code !== 'ok') return <ServerUnreachable statusRes={serverInfoStatusRes} />
	if (serverLayerStatusRes.code !== 'ok') return null
	const layersStatus = serverLayerStatusRes.data
	const currentMatch = serverLayerStatusRes.data.currentMatch
	const serverInfo = serverInfoStatusRes.data
	const [team1Elt, team2Elt] = getTeamsDisplay(layersStatus.currentLayer.id, currentMatch?.ordinal, false)
	const isEmpty = serverInfo.playerCount === 0

	let postGameElt: React.ReactNode = null
	if (!isEmpty && currentMatch?.status === 'post-game') {
		postGameElt = (
			<div className="flex space-x-2">
				<Badge variant="outline" className="flex items-center p-1 rounded-md">
					<span className="pr-1">Post-Game</span>
					<Timer zeros start={currentMatch.endTime.getTime()} className="font-mono" />
				</Badge>
				{currentMatch.outcome.type === 'draw' && (
					<Badge variant="outline" className="flex items-center p-1 rounded-md">
						<span className="pr-1">Draw</span>
					</Badge>
				)}
				{currentMatch.outcome.type === 'team1' && (
					<span className="flex items-center flex-nowrap text-sm gap 1">
						{team1Elt} has won {currentMatch.outcome.team1Tickets} to {currentMatch.outcome.team2Tickets}
					</span>
				)}
				{currentMatch.outcome.type === 'team2' && (
					<span className="flex items-center flex-nowrap text-sm gap-1">
						{team2Elt} has won {currentMatch.outcome.team2Tickets} to {currentMatch.outcome.team1Tickets}
					</span>
				)}
			</div>
		)
	}

	return (
		<>
			<CardHeader className="flex flex-row items-center justify-between nowrap space-y-0">
				<span className="inline-flex space-x-2 items-baseline whitespace-nowrap">
					<CardTitle>
						Current Layer:
					</CardTitle>
					<div>
						{currentMatch
							? <LayerDisplay className={Typo.LayerText} item={LQY.getLayerItemForMatchHistoryEntry(currentMatch)} />
							: (DH.displayLayer(layersStatus.currentLayer))}
					</div>
				</span>
				{currentMatch && <LayerSourceDisplay source={currentMatch.layerSource} />}
			</CardHeader>
			<CardContent className="flex justify-between">
				<div className="flex items-center space-x-2">
					<div className="w-max">
						{isEmpty && (
							<Badge variant="outline" className="flex items-center">
								<span>Server empty</span>
							</Badge>
						)}
						{!serverRolling && !isEmpty && currentMatch?.status === 'in-progress' && (
							<Badge variant="secondary" className="flex items-center pointer-events-none p-1 rounded-md">
								<span className="pr-1">In progress:</span>
								{currentMatch.startTime && <Timer zeros start={currentMatch.startTime.getTime()} className="font-mono" />}
							</Badge>
						)}
						{serverRolling && (
							<Badge variant="info" className="flex items-center">
								<Icons.Loader2 className="mr-1 h-3 w-3 animate-spin" />
								<span>Switching to New Layer...</span>
							</Badge>
						)}
						{postGameElt}
					</div>
					<div>
					</div>
				</div>
			</CardContent>
			<PostGameBalanceTriggerAlert />
			{updatesToSquadServerDisabled && <SyncToSquadServerDisabledAlert />}
		</>
	)
}

export default function CurrentLayerCard() {
	return (
		<Card>
			<CurrentLayerCardContent />
		</Card>
	)
}

function SyncToSquadServerDisabledAlert() {
	const { enableUpdates } = QD.useToggleSquadServerUpdates()
	const layerStatusRes = SquadServerClient.useLayersStatus()
	const serverInfoRes = SquadServerClient.useServerInfoRes()
	const loggedInUser = useLoggedInUser()
	const hasDisableUpdatesPerm = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates'))
	const nextLayerDisplay = (layerStatusRes.code === 'ok' && layerStatusRes.data.nextLayer)
		? (
			<>
				Next Layer is set to: <b>{DH.displayLayer(layerStatusRes.data.nextLayer)}</b>t
			</>
		)
		: ''
	return (
		<Alert variant="destructive">
			<AlertTitle>Updates to Squad Server have been Disabled</AlertTitle>
			<div className="flex items-center justify-between">
				<AlertDescription>
					<p>
						SLM is not currently syncing layers in the queue to{' '}
						<b>{serverInfoRes.code === 'ok' ? serverInfoRes.data.name : 'Squad Server'}</b>.
					</p>
					<p>
						{nextLayerDisplay}
					</p>
				</AlertDescription>
				<Button onClick={enableUpdates} disabled={!hasDisableUpdatesPerm} variant="secondary">Re-Enable</Button>
			</div>
		</Alert>
	)
}

function PostGameBalanceTriggerAlert() {
	const currentMatch = MatchHistoryClient.useCurrentMatch()
	const allTriggerEvents = MatchHistoryClient.useMatchHistoryState().recentBalanceTriggerEvents
	if (!currentMatch || currentMatch.status !== 'post-game') return null
	const events = allTriggerEvents.filter(event => event.matchTriggeredId === currentMatch.historyEntryId)
		.sort((a, b) => BAL.getTriggerPriority(b.level) - BAL.getTriggerPriority(a.level))
	if (events.length === 0) return null
	const alerts = events.map(event => <BalanceTriggerAlert key={event.id} event={event} referenceMatch={currentMatch} />)
	if (alerts.length === 1) return alerts[0]
	return (
		<div className="flex flex-col space-y-1">
			{alerts[0]}
			<Accordion type="single" collapsible className="w-full">
				<AccordionItem value="additional-alerts">
					<AccordionTrigger className="py-2 text-sm">
						Show {alerts.length - 1} more
					</AccordionTrigger>
					<AccordionContent className="max-h-80 overflow-y-auto">
						<div className="flex flex-col space-y-2">
							{alerts.slice(1)}
						</div>
					</AccordionContent>
				</AccordionItem>
			</Accordion>
		</div>
	)
}
