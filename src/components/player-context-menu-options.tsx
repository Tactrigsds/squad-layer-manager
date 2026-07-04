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
	Item: React.ComponentType<{ onClick?: () => void; disabled?: boolean; className?: string; children?: React.ReactNode }>
	Separator: React.ComponentType
	Sub: React.ComponentType<{ children?: React.ReactNode }>
	SubTrigger: React.ComponentType<{ disabled?: boolean; children?: React.ReactNode }>
	SubContent: React.ComponentType<{ children?: React.ReactNode }>
}

export const contextMenuSlots: MenuSlots = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

type PlayerLinkIds = {
	eos: SM.PlayerId
	username?: string
	steam?: string
	epic?: string
	bmProfileUrl?: string
}

// same fallback the player details window uses when no BM profile is cached
function bmSearchUrl(eos: string) {
	return `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${eos}&filter%5Bservers%5D=false&filter%5BplayerFlags%5D=&sort=score&showServers=true&method=quick`
}

function usePlayerLinkIds(playerIds: SM.PlayerId[], stores: SquadServerFrame.KeyProp): PlayerLinkIds[] {
	return ZusUtils.useStore(
		stores.squadServer,
		BattlemetricsClient.playerBmData$,
		(chatStore: ChatPrt.Store, bmData: BM.PublicPlayerBmData): PlayerLinkIds[] =>
			playerIds.map(playerId => {
				const player = SM.PlayerIds.find(ChatPrt.Sel.chatState(chatStore).players, p => p.ids, playerId)
				const bm = bmData[playerId]
				return {
					eos: playerId,
					username: player?.ids.username,
					steam: player?.ids.steam ?? bm?.playerIds.steam,
					epic: player?.ids.epic,
					bmProfileUrl: bm?.profileUrl,
				}
			}),
	)
}

// appends "(n/total)" when only some of the selected players have the id backing an entry
function partialCountSuffix(count: number, total: number) {
	return total > 1 && count < total ? ` (${count}/${total})` : ''
}

export function PlayerOpenLinksSub(
	{ playerIds, slots, stores }: { playerIds: SM.PlayerId[]; slots: MenuSlots; stores: SquadServerFrame.KeyProp },
) {
	const { Item, Sub, SubTrigger, SubContent } = slots
	const players = usePlayerLinkIds(playerIds, stores)
	const openAll = (urls: string[]) => {
		for (const url of urls) window.open(url, '_blank', 'noopener,noreferrer')
	}
	const steamIds = players.map(p => p.steam).filter((s): s is string => s != null)
	const bmUrls = players.map(p => p.bmProfileUrl ?? bmSearchUrl(p.eos))
	const links: { label: string; urls: string[] }[] = [
		{ label: 'Steam', urls: steamIds.map(id => `https://steamcommunity.com/profiles/${id}`) },
		{ label: 'CBL', urls: steamIds.map(id => `https://communitybanlist.com/search/${id}`) },
		{ label: 'MySquadStats', urls: steamIds.map(id => `https://mysquadstats.com/search/${id}#vanillaStats`) },
		{ label: 'BattleMetrics', urls: bmUrls },
	]
	return (
		<Sub>
			<SubTrigger>Open</SubTrigger>
			<SubContent>
				{links.map(({ label, urls }) => (
					<Item key={label} disabled={urls.length === 0} onClick={() => openAll(urls)}>
						{label}
						{partialCountSuffix(urls.length, players.length)}
					</Item>
				))}
			</SubContent>
		</Sub>
	)
}

export function PlayerCopyIdsSub(
	{ playerIds, slots, stores }: { playerIds: SM.PlayerId[]; slots: MenuSlots; stores: SquadServerFrame.KeyProp },
) {
	const { Item, Sub, SubTrigger, SubContent } = slots
	const players = usePlayerLinkIds(playerIds, stores)
	const { toast } = useToast()
	const pickAll = (pick: (p: PlayerLinkIds) => string | undefined) => players.map(pick).filter((v): v is string => v != null)
	const ids: { label: string; values: string[] }[] = [
		{ label: 'Username', values: pickAll(p => p.username) },
		{ label: 'EOS ID', values: pickAll(p => p.eos) },
		{ label: 'Steam ID', values: pickAll(p => p.steam) },
		{ label: 'Epic ID', values: pickAll(p => p.epic) },
	]
	const copyAll = (label: string, values: string[]) => {
		void navigator.clipboard.writeText(values.join('\n'))
		toast({
			title: 'Copied',
			description: values.length > 1 ? `${values.length} ${label}s copied to clipboard` : `${label} copied to clipboard`,
		})
	}
	return (
		<Sub>
			<SubTrigger>Copy</SubTrigger>
			<SubContent>
				{ids.map(({ label, values }) => (
					<Item key={label} disabled={values.length === 0} onClick={() => copyAll(label, values)}>
						{label}
						{playerIds.length > 1 ? 's' : ''}
						{partialCountSuffix(values.length, players.length)}
					</Item>
				))}
			</SubContent>
		</Sub>
	)
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
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
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
			})
		} finally {
			unsubscribe()
		}
	}

	async function warn() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('WARNING_PLAYERS', async () => {
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
		})
	}

	function copyTeleportCommand() {
		void navigator.clipboard.writeText(`AdminTeleportToPlayer ${playerId}`)
		toast({ title: 'Copied', description: 'Teleport command copied to clipboard' })
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('REMOVING_FROM_SQUAD', async () => {
			const squadLabel = playerInfo?.squadName ? `"${playerInfo.squadName}"` : 'their squad'
			const result = await openDialog({
				title: 'Remove from Squad',
				description: `Remove this player from ${squadLabel}?`,
				buttons: [{ id: 'confirm', label: 'Remove' }],
			})
			if (result !== 'confirm') return
			await removeFromSquadMutation.mutateAsync({ serverId, playerId })
		})
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		const { squadId, teamId, squadName } = playerInfo
		await UPClient.Actions.withPlayerDialogue('DISBANDING_SQUAD', async () => {
			const squadLabel = squadName ? `"${squadName}"` : `squad ${squadId}`
			const result = await openDialog({
				title: 'Disband Squad',
				description: `Disband ${squadLabel} on team ${teamId}?`,
				buttons: [{ id: 'confirm', label: 'Disband' }],
			})
			if (result !== 'confirm') return
			await disbandSquadMutation.mutateAsync({ serverId, teamId: teamId as 1 | 2, squadId })
		})
	}

	async function resetSquadName() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		const { squadId, teamId, squadName } = playerInfo
		await UPClient.Actions.withPlayerDialogue('RESETTING_SQUAD_NAME', async () => {
			const squadLabel = squadName ? `"${squadName}"` : `squad ${squadId}`
			const result = await openDialog({
				title: 'Reset Squad Name',
				description: `Reset the name of ${squadLabel} to default?`,
				buttons: [{ id: 'confirm', label: 'Reset' }],
			})
			if (result !== 'confirm') return
			await resetSquadNameMutation.mutateAsync({ serverId, teamId: teamId as 1 | 2, squadId })
		})
	}

	async function demoteCommander() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('DEMOTING_COMMANDER', async () => {
			const result = await openDialog({
				title: 'Demote Commander',
				description: 'Demote this player from commander?',
				buttons: [{ id: 'confirm', label: 'Demote' }],
			})
			if (result !== 'confirm') return
			await demoteCommanderMutation.mutateAsync({ serverId, playerId })
		})
	}

	const isOnServer = playerInfo !== null
	const inSquad = isOnServer && playerInfo.squadId !== null

	// Renders the flat list of select-type items for a given scope: 'team' selects only the
	// clicked player's team, 'all' selects across both teams. The Squad item only appears under
	// 'team' since a squad belongs to a single team.
	function selectItems(scope: 'team' | 'all') {
		const teamId = scope === 'team' ? (playerInfo?.teamId ?? undefined) : undefined
		const teamMissing = scope === 'team' && playerInfo?.teamId == null
		const sc = (team: string, all: string) => (scope === 'team' ? team : all)
		return (
			<>
				{scope === 'team' && (
					<Item
						disabled={!inSquad}
						onClick={() => {
							TSWClient.Actions.ensureViewingTeams(serverId)
							const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer)).players
							SquadServerClient.Actions.selectSquad(playerId, players)
						}}
					>
						Squad{playerInfo?.squadName ? ` (${playerInfo.squadName})` : ''}
						<ContextMenuShortcut>⇧+click squad cell</ContextMenuShortcut>
					</Item>
				)}
				<Item
					disabled={playerInfo?.role == null || teamMissing}
					onClick={() => {
						if (playerInfo?.role == null) return
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.selectAllWithRole(stores, playerInfo.role, teamId)
					}}
				>
					Role{playerInfo?.role != null ? ` (${playerInfo.role})` : ''}
					<ContextMenuShortcut>{sc('⇧+click role cell', '⇧+Ctrl+click role cell')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={grouping == null || teamMissing}
					onClick={() => {
						if (grouping == null) return
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.selectGrouping(stores, grouping, teamId)
					}}
				>
					Grouping{grouping != null ? ` (${grouping})` : ''}
					<ContextMenuShortcut>{sc('⇧+click grouping cell', '⇧+Ctrl+click grouping cell')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!playerInfo?.isLeader || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.selectAllSquadLeaders(stores, teamId)
					}}
				>
					Squad Leaders
				</Item>
				<Item
					disabled={!playerInfo?.isAdmin || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.selectAllAdmins(stores, teamId)
					}}
				>
					Admins
					<ContextMenuShortcut>{sc('⇧+click admin badge', '⇧+Ctrl+click admin badge')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!isOnServer || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.selectAllTeamPlayers(stores, teamId)
					}}
				>
					All Players
					<ContextMenuShortcut>{sc('⇧+click select-all box', '⇧+Ctrl+click select-all box')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerClient.Actions.invertSelection(stores, teamId)
					}}
				>
					Invert
					<ContextMenuShortcut>{sc('Alt+click select-all box', 'Alt+Ctrl+click select-all box')}</ContextMenuShortcut>
				</Item>
			</>
		)
	}

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
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={switchNow}
					disabled={!!manageDenied || !otherTeam || !canSwitchNow}
				>
					Switch Now
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.removeSwitch(stores, [playerId])}
					disabled={!!manageDenied || !existingSwitch}
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
			<PlayerOpenLinksSub playerIds={[playerId]} slots={slots} stores={stores} />
			<PlayerCopyIdsSub playerIds={[playerId]} slots={slots} stores={stores} />
			<Separator />
			<Sub>
				<SubTrigger disabled={!isOnServer}>Select from Team</SubTrigger>
				<SubContent>{selectItems('team')}</SubContent>
			</Sub>
			<Sub>
				<SubTrigger disabled={!isOnServer}>Select All</SubTrigger>
				<SubContent>{selectItems('all')}</SubContent>
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
