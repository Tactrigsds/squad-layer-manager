import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DialogTrigger } from '@/components/ui/dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import * as DH from '@/lib/display-helpers'
import { getTeamsDisplay } from '@/lib/display-helpers-react.tsx'
import * as SM from '@/lib/rcon/squad-models'
import { assertNever } from '@/lib/typeGuards.ts'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as RbacClient from '@/systems.client/rbac.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client.ts'
import { useLoggedInUser } from '@/systems.client/users.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import LayerDisplay from './layer-display.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import { Timer } from './timer.tsx'
import { DropdownMenuItem } from './ui/dropdown-menu.tsx'

export default function CurrentLayerCard(props: { serverStatus: SM.ServerStatusWithCurrentMatch }) {
	const historyEntry = MatchHistoryClient.useCurrentMatchDetails()
	const layerDetails = M.getLayerDetailsFromUnvalidated(props.serverStatus.currentLayer)
	const [team1Elt, team2Elt] = getTeamsDisplay(layerDetails, undefined, false)
	const loggedInUser = useLoggedInUser()
	const canEndMatch = !loggedInUser || RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match'))

	const isEmpty = props.serverStatus.playerCount === 0

	let postGameElt: React.ReactNode = null
	if (!isEmpty && historyEntry?.status === 'post-game') {
		postGameElt = (
			<div className="flex flex-col space-y-1">
				<Badge variant="outline" className="flex items-center">
					<span className="pr-1">Post-Game</span>
					<Timer start={historyEntry.endTime.getTime()} className="font-mono" />
				</Badge>
				{historyEntry.outcome.type === 'draw' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">Draw</span>
					</Badge>
				)}
				{historyEntry.outcome.type === 'team1' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">
							{team1Elt} has won ({historyEntry.outcome.team1Tickets} to {historyEntry.outcome.team2Tickets})
						</span>
					</Badge>
				)}
				{historyEntry.outcome.type === 'team2' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">
							{team2Elt} has won ({historyEntry.outcome.team2Tickets} to {historyEntry.outcome.team1Tickets})
						</span>
					</Badge>
				)}
			</div>
		)
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between nowrap space-y-0">
				<span className="flex space-x-2 items-center">
					<CardTitle>
						Current Layer:
					</CardTitle>
					<div>
						<LayerDisplay layerId={props.serverStatus.currentLayer.id} normTeamOffset={historyEntry?.normTeamOffset} />
					</div>
				</span>
				{historyEntry && <LayerSourceDisplay source={historyEntry.layerSource} />}
			</CardHeader>
			<CardContent className="flex justify-between">
				<div className="flex items-center space-x-2">
					<div className="flex space-x-2 items-center">
						<div>{props.serverStatus.playerCount} / {props.serverStatus.maxPlayerCount} online</div>
						<div>{props.serverStatus.queueLength} / {props.serverStatus.maxQueueLength} in queue</div>
					</div>
					<div className="w-max">
						{isEmpty && (
							<Badge variant="outline" className="flex items-center">
								<span>Server empty</span>
							</Badge>
						)}
						{!isEmpty && historyEntry?.status === 'in-progress' && (
							<Badge variant="secondary" className="flex items-center">
								<span className="pr-1">In progress:</span>
								<Timer zeros={true} start={historyEntry.startTime.getTime()} className="font-mono" />
							</Badge>
						)}
						{postGameElt}
					</div>
					<div>
					</div>
				</div>
				<EndMatchDialog>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon">
								<Icons.Ellipsis />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DialogTrigger asChild>
								<DropdownMenuItem disabled={!canEndMatch} className="bg-destructive text-destructive-foreground focus:bg-red-600">
									End Match
								</DropdownMenuItem>
							</DialogTrigger>
						</DropdownMenuContent>
					</DropdownMenu>
				</EndMatchDialog>
			</CardContent>
		</Card>
	)
}

function EndMatchDialog(props: { children: React.ReactNode }) {
	const [isOpen, setIsOpen] = React.useState(false)

	const loggedInUser = useLoggedInUser()
	const endMatchMutation = SquadServerClient.useEndMatch()
	const serverStatusRes = SquadServerClient.useSquadServerStatus()
	if (!serverStatusRes || serverStatusRes?.code === 'err:rcon') return null
	const serverStatus = serverStatusRes.data

	async function endMatch() {
		setIsOpen(false)
		const res = await endMatchMutation.mutateAsync()
		switch (res.code) {
			case 'ok':
				globalToast$.next({ title: 'Match ended!' })
				break
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'err':
				console.error(res)
				globalToast$.next({ title: 'error while ending match', variant: 'destructive' })
				break
			default:
				assertNever(res)
		}
	}

	const canEndMatch = !loggedInUser || RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match'))
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{props.children}
			<DialogContent>
				<DialogHeader>
					<DialogTitle>End Match</DialogTitle>
				</DialogHeader>
				<DialogDescription>
					Are you sure you want to end the match for <b>{serverStatus?.name}</b>?
				</DialogDescription>
				<DialogFooter>
					<Button disabled={!canEndMatch} onClick={endMatch} variant="destructive">
						End Match
					</Button>
					<Button
						onClick={() => {
							setIsOpen(false)
						}}
						variant="secondary"
					>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
