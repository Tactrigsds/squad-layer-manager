import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DialogTrigger } from '@/components/ui/dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useToast } from '@/hooks/use-toast'
import { getTeamsDisplay } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import { assertNever } from '@/lib/type-guards.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as QD from '@/systems.client/queue-dashboard.ts'
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

export default function CurrentLayerCard() {
	const loggedInUser = useLoggedInUser()
	const serverLayerStatusRes = SquadServerClient.useLayersStatus()
	const serverInfoStatusRes = SquadServerClient.useServerInfo()

	const canEndMatch = !loggedInUser || RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match'))
	const hasDisableUpdatesPerm = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates'))
	const canDisableFogOfWar = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:turn-fog-off'))

	const updatesToSquadServerDisabled = Zus.useStore(QD.QDStore, s => s.serverState?.settings.updatesToSquadServerDisabled)
	const { disableUpdates, enableUpdates } = QD.useToggleSquadServerUpdates()
	const disableFogOfWarMutation = SquadServerClient.useDisableFogOfWarMutation()
	const { toast } = useToast()
	async function disableFogOfWar() {
		const res = await disableFogOfWarMutation.mutateAsync()
		switch (res.code) {
			case 'err:rcon':
				break
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast({
					title: 'Fog of War disabled for current match',
					variant: 'default',
				})
				break
			default:
				assertNever(res)
		}
	}

	if (serverLayerStatusRes.code !== 'ok') return null
	if (serverInfoStatusRes.code !== 'ok') return null
	const layersStatus = serverLayerStatusRes.data
	const currentMatch = serverLayerStatusRes.data.currentMatch
	const serverInfo = serverInfoStatusRes.data
	const [team1Elt, team2Elt] = getTeamsDisplay(layersStatus.currentLayer.id, currentMatch?.ordinal, false)
	const isEmpty = serverInfo.playerCount === 0

	let postGameElt: React.ReactNode = null
	if (!isEmpty && currentMatch?.status === 'post-game') {
		postGameElt = (
			<div className="flex space-x-2">
				<Badge variant="outline" className="flex items-center">
					<span className="pr-1">Post-Game</span>
					<Timer zeros={true} start={currentMatch.endTime.getTime()} className="font-mono" />
				</Badge>
				{currentMatch.outcome.type === 'draw' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">Draw</span>
					</Badge>
				)}
				{currentMatch.outcome.type === 'team1' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">
							{team1Elt} has won ({currentMatch.outcome.team1Tickets} to {currentMatch.outcome.team2Tickets})
						</span>
					</Badge>
				)}
				{currentMatch.outcome.type === 'team2' && (
					<Badge variant="outline" className="flex items-center">
						<span className="pr-1">
							{team2Elt} has won ({currentMatch.outcome.team2Tickets} to {currentMatch.outcome.team1Tickets})
						</span>
					</Badge>
				)}
			</div>
		)
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between nowrap space-y-0">
				<span className="flex space-x-2 items-center whitespace-nowrap">
					<CardTitle>
						Current Layer:
					</CardTitle>
					<div>
						{currentMatch
							? <LayerDisplay item={LQY.getLayerItemForMatchHistoryEntry(currentMatch)} />
							: (DH.displayUnvalidatedLayer(layersStatus.currentLayer))}
					</div>
				</span>
				{currentMatch && <LayerSourceDisplay source={currentMatch.layerSource} />}
			</CardHeader>
			<CardContent className="flex justify-between">
				<div className="flex items-center space-x-2">
					<div className="flex space-x-2 items-center">
						<div>{serverInfo.playerCount} / {serverInfo.maxPlayerCount} online</div>
						<div>{serverInfo.queueLength} / {serverInfo.maxQueueLength} in queue</div>
					</div>
					<div className="w-max">
						{isEmpty && (
							<Badge variant="outline" className="flex items-center">
								<span>Server empty</span>
							</Badge>
						)}
						{!isEmpty && currentMatch?.status === 'in-progress' && (
							<Badge variant="secondary" className="flex items-center">
								<span className="pr-1">In progress:</span>
								{currentMatch.startTime && <Timer zeros={true} start={currentMatch.startTime.getTime()} className="font-mono" />}
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
							{updatesToSquadServerDisabled
								? <DropdownMenuItem disabled={!hasDisableUpdatesPerm} onClick={enableUpdates}>Re-enable SLM Updates</DropdownMenuItem>
								: (
									<DropdownMenuItem
										title="Prevents SLM from setting layers on the Squad Server"
										disabled={!hasDisableUpdatesPerm}
										onClick={disableUpdates}
									>
										Disable SLM Updates
									</DropdownMenuItem>
								)}
							<DropdownMenuItem title="Disables Fog Of War for the current match" disabled={!canDisableFogOfWar} onClick={disableFogOfWar}>
								Disable Fog Of War
							</DropdownMenuItem>
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
	const serverInfoRes = SquadServerClient.useServerInfo()
	if (!serverInfoRes || serverInfoRes?.code !== 'ok') return null
	const serverInfo = serverInfoRes.data

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
					Are you sure you want to end the match for <b>{serverInfo?.name}</b>?
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
