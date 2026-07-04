import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useToast } from '@/hooks/use-toast'
import * as ZusUtils from '@/lib/zustand'
import type * as BM from '@/models/battlemetrics.models'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as UPClient from '@/systems/user-presence.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export type MenuSlots = {
	Item: React.ComponentType<{ onClick?: () => void; disabled?: boolean; children?: React.ReactNode }>
	Separator: React.ComponentType
	Sub: React.ComponentType<{ children?: React.ReactNode }>
	SubTrigger: React.ComponentType<{ children?: React.ReactNode }>
	SubContent: React.ComponentType<{ children?: React.ReactNode }>
}

const contextMenuSlots: MenuSlots = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

export function PlayerMenuItems(
	{ playerId, slots, stores }: { playerId: SM.PlayerId; slots: MenuSlots; stores: SquadServerFrame.KeyProp },
) {
	const { Item, Separator, Sub, SubTrigger, SubContent } = slots
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const warnMutation = SquadServerClient.useWarnPlayerMutation()
	const demoteCommanderMutation = SquadServerClient.useDemoteCommanderMutation()
	const disbandSquadMutation = SquadServerClient.useDisbandSquadMutation()
	const removeFromSquadMutation = SquadServerClient.useRemoveFromSquadMutation()
	const resetSquadNameMutation = SquadServerClient.useResetSquadNameMutation()
	const serverId = stores.squadServer.serverId

	const otherTeam = ZusUtils.useStore(
		stores.squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		(chatStore: ChatPrt.Store, currentMatch: MH.MatchDetails | undefined): MH.NormedTeamId | null => {
			if (!currentMatch) return null
			const player = SM.PlayerIds.find(ChatPrt.Sel.chatState(chatStore).players, p => p.ids, playerId)
			if (!player?.teamId) return null
			const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
			return normed === 'A' ? 'B' : 'A'
		},
	)

	const playerInfo = ZusUtils.useStore(
		stores.squadServer,
		(chatStore: ChatPrt.Store) => {
			const players = ChatPrt.Sel.chatState(chatStore).players
			const squads = ChatPrt.Sel.chatState(chatStore).squads
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) return null
			const squad = player.squadId !== null
				? squads.find(s => s.squadId === player.squadId && s.teamId === player.teamId)
				: undefined
			return {
				squadId: player.squadId,
				teamId: player.teamId,
				username: player.ids.username,
				role: player.role,
				squadName: squad?.squadName ?? null,
				isCommander: player.isLeader && squad?.squadName === 'Command Squad',
				isLeader: player.isLeader,
				isAdmin: player.isAdmin,
			}
		},
	)

	const grouping = ZusUtils.useStore(
		stores.squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		(
			chatStore: ChatPrt.Store,
			currentMatch: MH.MatchDetails | undefined,
			bmData: BM.PublicPlayerBmData,
			bmStore: BM.StoreState,
			settings: PublicSettings | undefined,
		): string | undefined => {
			const player = SM.PlayerIds.find(ChatPrt.Sel.chatState(chatStore).players, p => p.ids, playerId)
			if (player?.teamId == null) return undefined
			const enriched = TeamsPanelModels.Sel.playersForTeam(player.teamId)(chatStore, currentMatch, bmData, bmStore, settings)
			return SM.PlayerIds.find(enriched, p => p.ids, playerId)?.grouping
		},
	)

	const existingSwitch = ZusUtils.useStore(
		stores.squadServer,
		s => TSWClient.Sel.localState(s).editedSwitches.get(playerId) ?? null,
	)

	const canSwitchNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwitchNow([playerId]))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canQueue([playerId]))

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))

	async function switchNow() {
		if (!otherTeam) return
		const initialTeam = TSWClient.Sel.localState(ZusUtils.getState(stores.squadServer)).players.get(playerId)
		const unsubscribe = ZusUtils.resolveReadStore(stores.squadServer).subscribe(state => {
			if (TSWClient.Sel.localState(state).players.get(playerId) !== initialTeam) closeDialog()
		})
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'SWITCHING_PLAYERS' })
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
			TSWClient.Actions.switchNow(stores, [playerId])
		} finally {
			unsubscribe()
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	async function warn() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'WARNING_PLAYERS' })
		try {
			let reason = ''
			const result = await openDialog({
				title: `Warn ${playerInfo?.username ?? 'Player'}`,
				content: (
					<input
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						placeholder="Warn reason"
						autoFocus
						onChange={e => {
							reason = e.target.value
						}}
					/>
				),
				buttons: [{ id: 'confirm', label: 'Send Warning' }],
			})
			if (result !== 'confirm' || !reason.trim()) return
			await warnMutation.mutateAsync({ serverId, playerId, reason: reason.trim() })
		} finally {
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	function copyTeleportCommand() {
		void navigator.clipboard.writeText(`AdminTeleportToPlayer ${playerId}`)
		toast({ title: 'Copied', description: 'Teleport command copied to clipboard' })
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'REMOVING_FROM_SQUAD' })
		try {
			const squadLabel = playerInfo?.squadName ? `"${playerInfo.squadName}"` : 'their squad'
			const result = await openDialog({
				title: 'Remove from Squad',
				description: `Remove this player from ${squadLabel}?`,
				buttons: [{ id: 'confirm', label: 'Remove' }],
			})
			if (result !== 'confirm') return
			await removeFromSquadMutation.mutateAsync({ serverId, playerId })
		} finally {
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'DISBANDING_SQUAD' })
		try {
			const squadLabel = playerInfo.squadName ? `"${playerInfo.squadName}"` : `squad ${playerInfo.squadId}`
			const result = await openDialog({
				title: 'Disband Squad',
				description: `Disband ${squadLabel} on team ${playerInfo.teamId}?`,
				buttons: [{ id: 'confirm', label: 'Disband' }],
			})
			if (result !== 'confirm') return
			await disbandSquadMutation.mutateAsync({ serverId, teamId: playerInfo.teamId as 1 | 2, squadId: playerInfo.squadId })
		} finally {
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	async function resetSquadName() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'RESETTING_SQUAD_NAME' })
		try {
			const squadLabel = playerInfo.squadName ? `"${playerInfo.squadName}"` : `squad ${playerInfo.squadId}`
			const result = await openDialog({
				title: 'Reset Squad Name',
				description: `Reset the name of ${squadLabel} to default?`,
				buttons: [{ id: 'confirm', label: 'Reset' }],
			})
			if (result !== 'confirm') return
			await resetSquadNameMutation.mutateAsync({ serverId, teamId: playerInfo.teamId as 1 | 2, squadId: playerInfo.squadId })
		} finally {
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	async function demoteCommander() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		UPClient.Actions.updateActivity({ code: 'set-player-dialogue', dialog: 'DEMOTING_COMMANDER' })
		try {
			const result = await openDialog({
				title: 'Demote Commander',
				description: 'Demote this player from commander?',
				buttons: [{ id: 'confirm', label: 'Demote' }],
			})
			if (result !== 'confirm') return
			await demoteCommanderMutation.mutateAsync({ serverId, playerId })
		} finally {
			UPClient.Actions.updateActivity({ code: 'clear-player-dialogue' })
		}
	}

	const isOnServer = playerInfo !== null
	const inSquad = isOnServer && playerInfo.squadId !== null

	return (
		<>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.switchNext(stores, [playerId])}
					disabled={!!manageDenied || !otherTeam || !canQueue}
				>
					Switch Next
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={switchNow} disabled={!!manageDenied || !otherTeam || !canSwitchNow}>
					Switch Now
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.removeSwitch(stores, [playerId])}
					disabled={!!manageDenied || !existingSwitch || !canSwitchNow}
				>
					Delete Switch
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={warnDenied}>
				<Item onClick={warn} disabled={!!warnDenied || !isOnServer}>
					Warn
				</Item>
			</PermissionDeniedTooltip>
			<Item onClick={copyTeleportCommand} disabled={!isOnServer}>
				Copy Teleport Command
			</Item>
			<Separator />
			<Sub>
				<SubTrigger>Select..</SubTrigger>
				<SubContent>
					<Item
						disabled={!inSquad}
						onClick={() => {
							TSWClient.Actions.ensureViewingTeams(serverId)
							const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer)).players
							SquadServerClient.Actions.selectSquad(playerId, players)
						}}
					>
						<span title="Shortcut: shift+click the player's Squad cell in the teams panel">Squad</span>
						<ContextMenuShortcut>⇧+click squad cell</ContextMenuShortcut>
					</Item>
					<Item
						disabled={playerInfo?.role == null}
						onClick={() => {
							if (playerInfo?.role == null) return
							TSWClient.Actions.ensureViewingTeams(serverId)
							SquadServerClient.Actions.selectAllWithRole(stores, playerInfo.role)
						}}
					>
						<span title="Shortcut: shift+click the player's Role cell in the teams panel">
							Role{playerInfo?.role != null ? ` (${playerInfo.role})` : ''}
						</span>
						<ContextMenuShortcut>⇧+click role cell</ContextMenuShortcut>
					</Item>
					<Item
						disabled={grouping == null}
						onClick={() => {
							if (grouping == null) return
							TSWClient.Actions.ensureViewingTeams(serverId)
							SquadServerClient.Actions.selectGrouping(stores, grouping)
						}}
					>
						<span title="Shortcut: shift+click the player's Grouping cell in the teams panel">
							Grouping{grouping != null ? ` (${grouping})` : ''}
						</span>
						<ContextMenuShortcut>⇧+click grouping cell</ContextMenuShortcut>
					</Item>
					<Item
						disabled={!playerInfo?.isLeader}
						onClick={() => {
							TSWClient.Actions.ensureViewingTeams(serverId)
							SquadServerClient.Actions.selectAllSquadLeaders(stores)
						}}
					>
						All Squad Leaders
					</Item>
					<Item
						disabled={!playerInfo?.isAdmin}
						onClick={() => {
							TSWClient.Actions.ensureViewingTeams(serverId)
							SquadServerClient.Actions.selectAllAdmins(stores)
						}}
					>
						<span title="Shortcut: shift+click the shield badge next to an admin's name">All Admins</span>
						<ContextMenuShortcut>⇧+click admin badge</ContextMenuShortcut>
					</Item>
				</SubContent>
			</Sub>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={removeFromSquad} disabled={!!manageDenied || !inSquad}>
					Remove from Squad
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={disbandSquad} disabled={!!manageDenied || !inSquad}>
					Disband Squad
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={resetSquadName} disabled={!!manageDenied || !inSquad}>
					Reset Squad Name
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={demoteCommander} disabled={!!manageDenied || !playerInfo?.isCommander}>
					Demote Commander
				</Item>
			</PermissionDeniedTooltip>
		</>
	)
}

export default function PlayerContextMenuOptions(
	{ playerId, stores }: { playerId: SM.PlayerId; stores: SquadServerFrame.KeyProp },
) {
	return <PlayerMenuItems playerId={playerId} slots={contextMenuSlots} stores={stores} />
}
