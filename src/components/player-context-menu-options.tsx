import { useToast } from '@/hooks/use-toast'
import * as ZusUtils from '@/lib/zustand'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export type MenuSlots = {
	Item: React.ComponentType<{ onClick?: () => void; disabled?: boolean; children?: React.ReactNode }>
	Separator: React.ComponentType
}

const contextMenuSlots: MenuSlots = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

export function PlayerMenuItems({ playerId, slots }: { playerId: SM.PlayerId; slots: MenuSlots }) {
	const { Item, Separator } = slots
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const warnMutation = SquadServerClient.useWarnPlayerMutation()
	const demoteCommanderMutation = SquadServerClient.useDemoteCommanderMutation()
	const disbandSquadMutation = SquadServerClient.useDisbandSquadMutation()
	const removeFromSquadMutation = SquadServerClient.useRemoveFromSquadMutation()
	const resetSquadNameMutation = SquadServerClient.useResetSquadNameMutation()

	const otherTeam = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		(chatStore: SquadServer.ChatStore, currentMatch: MH.MatchDetails | undefined): MH.NormedTeamId | null => {
			if (!currentMatch) return null
			const player = SM.PlayerIds.find(SquadServer.Select.chatState(chatStore).players, p => p.ids, playerId)
			if (!player?.teamId) return null
			const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
			return normed === 'A' ? 'B' : 'A'
		},
	)

	const playerInfo = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		(chatStore: SquadServer.ChatStore) => {
			const players = SquadServer.Select.chatState(chatStore).players
			const squads = SquadServer.Select.chatState(chatStore).squads
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) return null
			const squad = player.squadId !== null
				? squads.find(s => s.squadId === player.squadId && s.teamId === player.teamId)
				: undefined
			return {
				squadId: player.squadId,
				teamId: player.teamId,
				username: player.ids.username,
				squadName: squad?.squadName ?? null,
				isCommander: squad?.squadName === 'Command Squad',
			}
		},
	)

	const existingSwitch = ZusUtils.useStore(
		TSWClient.Store,
		s => TSWClient.Select.localState(s).editedSwitches.get(playerId) ?? null,
	)

	const canSwitchNow = ZusUtils.useStore(TSWClient.Store, TSWClient.Select.canSwitchNow([playerId]))
	const canQueue = ZusUtils.useStore(TSWClient.Store, TSWClient.Select.canQueue([playerId]))

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))

	async function switchNow() {
		if (!otherTeam) return
		const initialTeam = TSWClient.Select.localState(TSWClient.Store.getState()).players.get(playerId)
		const unsubscribe = TSWClient.Store.subscribe(state => {
			if (TSWClient.Select.localState(state).players.get(playerId) !== initialTeam) closeDialog()
		})
		try {
			const result = await openDialog({
				title: 'Switch Player Now',
				description: `Move this player to Team ${otherTeam} immediately?`,
				buttons: [{ id: 'confirm', label: 'Switch Now' }],
			})
			if (result === 'dismissed') {
				toast({ title: 'Switch cancelled', description: 'Player changed teams', variant: 'destructive' })
				return
			}
			if (result !== 'confirm') return
			TSWClient.Actions.switchNow([playerId])
		} finally {
			unsubscribe()
		}
	}

	async function warn() {
		TSWClient.Actions.ensureViewingTeams()
		let reason = ''
		const result = await openDialog({
			title: `Warn ${playerInfo?.username ?? 'Player'}`,
			content: (
				<input
					className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					placeholder="Warn reason"
					autoFocus
					onChange={e => { reason = e.target.value }}
				/>
			),
			buttons: [{ id: 'confirm', label: 'Send Warning' }],
		})
		if (result !== 'confirm' || !reason.trim()) return
		await warnMutation.mutateAsync({ playerId, reason: reason.trim() })
	}

	function copyTeleportCommand() {
		void navigator.clipboard.writeText(`AdminTeleportToPlayer ${playerId}`)
		toast({ title: 'Copied', description: 'Teleport command copied to clipboard' })
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams()
		const squadLabel = playerInfo?.squadName ? `"${playerInfo.squadName}"` : 'their squad'
		const result = await openDialog({
			title: 'Remove from Squad',
			description: `Remove this player from ${squadLabel}?`,
			buttons: [{ id: 'confirm', label: 'Remove' }],
		})
		if (result !== 'confirm') return
		await removeFromSquadMutation.mutateAsync(playerId)
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams()
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		const squadLabel = playerInfo.squadName ? `"${playerInfo.squadName}"` : `squad ${playerInfo.squadId}`
		const result = await openDialog({
			title: 'Disband Squad',
			description: `Disband ${squadLabel} on team ${playerInfo.teamId}?`,
			buttons: [{ id: 'confirm', label: 'Disband' }],
		})
		if (result !== 'confirm') return
		await disbandSquadMutation.mutateAsync({ teamId: playerInfo.teamId as 1 | 2, squadId: playerInfo.squadId })
	}

	async function resetSquadName() {
		TSWClient.Actions.ensureViewingTeams()
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		const squadLabel = playerInfo.squadName ? `"${playerInfo.squadName}"` : `squad ${playerInfo.squadId}`
		const result = await openDialog({
			title: 'Reset Squad Name',
			description: `Reset the name of ${squadLabel} to default?`,
			buttons: [{ id: 'confirm', label: 'Reset' }],
		})
		if (result !== 'confirm') return
		await resetSquadNameMutation.mutateAsync({ teamId: playerInfo.teamId as 1 | 2, squadId: playerInfo.squadId })
	}

	async function demoteCommander() {
		TSWClient.Actions.ensureViewingTeams()
		const result = await openDialog({
			title: 'Demote Commander',
			description: 'Demote this player from commander?',
			buttons: [{ id: 'confirm', label: 'Demote' }],
		})
		if (result !== 'confirm') return
		await demoteCommanderMutation.mutateAsync(playerId)
	}

	const isOnServer = playerInfo !== null
	const inSquad = isOnServer && playerInfo.squadId !== null

	return (
		<>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={switchNow} disabled={!!manageDenied || !otherTeam || !canSwitchNow}>
					Switch Now
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.switchNext([playerId])}
					disabled={!!manageDenied || !otherTeam || !canQueue}
				>
					Switch Next
				</Item>
			</PermissionDeniedTooltip>
			{existingSwitch && (
				<>
					<Separator />
					<PermissionDeniedTooltip denied={manageDenied}>
						<Item
							onClick={() => TSWClient.Actions.removeSwitch([playerId])}
							disabled={!!manageDenied || !canSwitchNow}
						>
							Cancel Switch
						</Item>
					</PermissionDeniedTooltip>
				</>
			)}
			<Separator />
			<PermissionDeniedTooltip denied={warnDenied}>
				<Item onClick={warn} disabled={!!warnDenied || !isOnServer}>
					Warn
				</Item>
			</PermissionDeniedTooltip>
			<Item onClick={copyTeleportCommand} disabled={!isOnServer}>
				Copy Teleport Command
			</Item>
			{inSquad && (
				<>
					<Separator />
					<Item onClick={() => { TSWClient.Actions.ensureViewingTeams(); SquadServerClient.PlayerSelectionStore.getState().selectSquad(playerId) }}>
						Select Squad
					</Item>
				</>
			)}
			{inSquad && (
				<>
					<Separator />
					<PermissionDeniedTooltip denied={manageDenied}>
						<Item onClick={removeFromSquad} disabled={!!manageDenied}>
							Remove from Squad
						</Item>
					</PermissionDeniedTooltip>
					<PermissionDeniedTooltip denied={manageDenied}>
						<Item onClick={disbandSquad} disabled={!!manageDenied}>
							Disband Squad
						</Item>
					</PermissionDeniedTooltip>
					<PermissionDeniedTooltip denied={manageDenied}>
						<Item onClick={resetSquadName} disabled={!!manageDenied}>
							Reset Squad Name
						</Item>
					</PermissionDeniedTooltip>
				</>
			)}
			{playerInfo?.isCommander && (
				<>
					<Separator />
					<PermissionDeniedTooltip denied={manageDenied}>
						<Item onClick={demoteCommander} disabled={!!manageDenied}>
							Demote Commander
						</Item>
					</PermissionDeniedTooltip>
				</>
			)}
		</>
	)
}

export default function PlayerContextMenuOptions({ playerId }: { playerId: SM.PlayerId }) {
	return <PlayerMenuItems playerId={playerId} slots={contextMenuSlots} />
}
