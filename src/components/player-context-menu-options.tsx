import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import * as ZodLib from '@/lib/zod'
import * as ZusUtils from '@/lib/zustand'
import type * as AAR from '@/models/admin-action-reasons.models'
import type * as BM from '@/models/battlemetrics.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UPClient from '@/systems/user-presence.client'
import * as WarnChat from '@/systems/warn-chat.client'
import React from 'react'
import { PlayerFlagsSub } from './bm-flag-workflows'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'
import { ReasonPicker, WarnReasonsSub } from './warn-reasons-sub'

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
				// recent rather than live: profile links are about who the player is, so they should keep working
				// after a mid-match disconnect
				const player = ChatPrt.Sel.recentPlayer(playerId)(chatStore)
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
	const pickAll = (pick: (p: PlayerLinkIds) => string | undefined) => players.map(pick).filter((v): v is string => v != null)
	const ids: { label: string; values: string[] }[] = [
		{ label: 'Username', values: pickAll(p => p.username) },
		{ label: 'EOS ID', values: pickAll(p => p.eos) },
		{ label: 'Steam ID', values: pickAll(p => p.steam) },
		{ label: 'Epic ID', values: pickAll(p => p.epic) },
	]
	const copyAll = (label: string, values: string[]) => {
		void navigator.clipboard.writeText(values.join('\n'))
		toast('Copied', {
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

// the Timeout dialog body: the duration input is kept in state (in addition to the ref the confirm handler reads) so
// the ReasonPicker's message preview can resolve {{duration}} live as the admin types. Shared with the bulk and squad
// timeout dialogs.
export function TimeoutDialogContent(
	{ durationRef, customReasonRef, presetReasonRef, maxTimeout, required }: {
		durationRef: React.MutableRefObject<string>
		customReasonRef: React.MutableRefObject<string>
		presetReasonRef: React.MutableRefObject<string>
		maxTimeout: number | null | undefined
		required?: boolean
	},
) {
	const [durationText, setDurationText] = React.useState(() => durationRef.current)
	const durationMs = ZodLib.tryParseHumanTimeToken(durationText.trim())
	return (
		<div className="grid gap-3 py-2">
			<div className="grid gap-2">
				<Label htmlFor="timeout-duration">Timeout duration</Label>
				<Input
					id="timeout-duration"
					autoComplete="off"
					placeholder={maxTimeout == null ? 'e.g. 30m, 2h, 1d' : `e.g. 30m, 2h (max ${ZodLib.formatHumanTime(maxTimeout)})`}
					defaultValue={durationRef.current}
					onChange={e => {
						durationRef.current = e.target.value
						setDurationText(e.target.value)
					}}
				/>
			</div>
			<ReasonPicker
				action="timeout"
				presetRef={presetReasonRef}
				customRef={customReasonRef}
				required={required}
				durationMs={durationMs}
			/>
		</div>
	)
}

export function PlayerMenuItems(
	{ playerId, slots, stores, omitWarn }: {
		playerId: SM.PlayerId
		slots: MenuSlots
		stores: SquadServerFrame.KeyProp
		// hidden inside the player details window, which has its own warn box at the bottom
		omitWarn?: boolean
	},
) {
	const { Item, Separator, Sub, SubTrigger, SubContent } = slots
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const openOrFocusWindow = useOpenOrFocusWindow()
	// holds the latest custom-reason input value (kill + kick + timeout dialogs); the alert dialog only resolves a
	// button id, so we read the reason from here rather than the (unmounting) DOM input when the dialog confirms
	const customReasonRef = React.useRef('')
	// same mechanism for the preset-reason pick in the action confirmation dialogs; reset on each dialog open
	const presetReasonRef = React.useRef('')
	const timeoutDurationRef = React.useRef('')

	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const kickMutation = SquadServerClient.useKickPlayersMutation()
	const timeoutMutation = TimeoutsClient.useTimeoutPlayerMutation()
	const maxTimeout = TimeoutsClient.useMaxTimeout()
	const killReasonRequired = SettingsClient.useReasonRequired('kill')
	const kickReasonRequired = SettingsClient.useReasonRequired('kick')
	const timeoutReasonRequired = SettingsClient.useReasonRequired('timeout')
	const removeReasonRequired = SettingsClient.useReasonRequired('remove-from-squad')
	const disbandReasonRequired = SettingsClient.useReasonRequired('disband-squad')
	const demoteReasonRequired = SettingsClient.useReasonRequired('demote-commander')
	const demoteCommanderMutation = SquadServerClient.useDemoteCommanderMutation()
	const killMutation = SquadServerClient.useKillMutation()
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

	const group = ZusUtils.useStore(
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
			return SM.PlayerIds.find(enriched, p => p.ids, playerId)?.group
		},
	)

	const existingSwap = ZusUtils.useStore(
		stores.squadServer,
		s => TSWClient.Sel.localState(s).editedSwaps.get(playerId) ?? null,
	)

	const canSwapNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwapNow([playerId]))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canQueue([playerId]))

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const kickDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:kick-players'))
	// timeout grants are comparator-matched (see useMaxTimeout), so the denial is synthesized rather than
	// coming from usePermsCheck
	const timeoutDenied = maxTimeout === undefined
		? RBAC.permissionDenied({ check: 'all', permits: [RBAC.perm('squad-server:timeout-players', { maxDurationMs: null })] })
		: null

	async function swapNow() {
		if (!otherTeam) return
		const initialTeam = TSWClient.Sel.localState(ZusUtils.getState(stores.squadServer)).players.get(playerId)
		const unsubscribe = ZusUtils.resolveReadStore(stores.squadServer).subscribe(state => {
			if (TSWClient.Sel.localState(state).players.get(playerId) !== initialTeam) closeDialog()
		})
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
				const result = await openDialog({
					title: 'Swap Player Now',
					variant: 'destructive',
					description: `Move ${playerInfo?.username ?? 'this player'} to Team ${otherTeam} immediately?`,
					buttons: [{ id: 'confirm', label: 'Swap Now' }],
				})
				if (result === 'dismissed') {
					toast.warning('Swap cancelled', { description: 'Player changed teams' })
					return
				}
				if (result !== 'confirm') return
				TSWClient.Actions.swapNow(stores, [playerId])
			})
		} finally {
			unsubscribe()
		}
	}

	async function kill() {
		if (!otherTeam) return
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Kill Player',
				variant: 'destructive',
				description: `Kill ${
					playerInfo?.username ?? 'this player'
				}? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.`,
				content: (
					<div className="grid gap-3 py-2">
						<ReasonPicker action="kill" presetRef={presetReasonRef} customRef={customReasonRef} required={killReasonRequired} />
					</div>
				),
				buttons: [{ id: 'confirm', label: 'Kill' }],
			})
			if (result !== 'confirm') return
			const input = SquadServerClient.readReasonInput({
				action: 'kill',
				required: killReasonRequired,
				presetRef: presetReasonRef,
				customRef: customReasonRef,
			})
			if (!input) return
			const res = await killMutation.mutateAsync({ serverId, playerIds: [playerId], ...input })
			if (res.code !== 'ok') {
				toast.error('Kill failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
				return
			}
			toast(`Killed ${playerInfo?.username ?? 'player'}`)
		})
	}

	async function kick() {
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Kick Player',
				variant: 'destructive',
				description: `Kick ${playerInfo?.username ?? 'this player'} from the server? They may rejoin immediately.`,
				content: (
					<div className="grid gap-3 py-2">
						<ReasonPicker action="kick" presetRef={presetReasonRef} customRef={customReasonRef} required={kickReasonRequired} />
					</div>
				),
				buttons: [{ id: 'confirm', label: 'Kick' }],
			})
			if (result !== 'confirm') return
			const input = SquadServerClient.readReasonInput({
				action: 'kick',
				required: kickReasonRequired,
				presetRef: presetReasonRef,
				customRef: customReasonRef,
			})
			if (!input) return
			const res = await kickMutation.mutateAsync({ serverId, playerIds: [playerId], ...input })
			if (res.code !== 'ok') {
				toast.error('Kick failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
				return
			}
			toast(`Kicked ${playerInfo?.username ?? 'player'}`)
		})
	}

	async function timeout() {
		timeoutDurationRef.current = ''
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Timeout Player',
				variant: 'destructive',
				description: `Kick ${
					playerInfo?.username ?? 'this player'
				}? They will be re-kicked on join from any SLM-managed server until the timeout expires.`,
				content: (
					<TimeoutDialogContent
						durationRef={timeoutDurationRef}
						customReasonRef={customReasonRef}
						presetReasonRef={presetReasonRef}
						maxTimeout={maxTimeout}
						required={timeoutReasonRequired}
					/>
				),
				buttons: [{ id: 'confirm', label: 'Timeout' }],
			})
			if (result !== 'confirm') return
			const durationMs = ZodLib.tryParseHumanTimeToken(timeoutDurationRef.current.trim())
			if (durationMs === undefined) {
				toast.error('Invalid duration', { description: 'Use a duration like 30m, 2h or 1d' })
				return
			}
			if (typeof maxTimeout === 'number' && durationMs > maxTimeout) {
				toast.error('Duration too long', { description: `Your maximum timeout is ${ZodLib.formatHumanTime(maxTimeout)}` })
				return
			}
			const input = SquadServerClient.readReasonInput({
				action: 'timeout',
				required: timeoutReasonRequired,
				presetRef: presetReasonRef,
				customRef: customReasonRef,
			})
			if (!input) return
			const res = await timeoutMutation.mutateAsync({ serverId, playerId, durationMs, ...input })
			if (res.code !== 'ok') {
				toast.error('Timeout failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
				return
			}
			toast(`Timed out ${playerInfo?.username ?? 'player'} for ${ZodLib.formatHumanTime(durationMs)}`)
		})
	}

	// open (or raise) the player's details window and focus its warn box, rather than a one-off dialog
	function warn() {
		openOrFocusWindow(WINDOW_ID.enum['player-details'], { playerId, stores })
		WarnChat.requestWarnFocus({ kind: 'player', playerId })
	}

	// preset warns skip the warn box and send immediately (single target)
	async function sendPresetWarn(reason: AAR.AdminActionReason) {
		const res = await warnPlayersMutation.mutateAsync({ serverId, playerIds: [playerId], presetReasonLabel: reason.label })
		if (res.code !== 'ok') {
			toast.error('Warn failed', { description: 'msg' in res ? res.msg : res.code })
			return
		}
		toast(`Warned ${playerInfo?.username ?? 'player'} for ${reason.label}`)
	}

	function copyTeleportCommand() {
		void navigator.clipboard.writeText(`AdminTeleportToPlayer ${playerId}`)
		toast('Copied', { description: 'Teleport command copied to clipboard' })
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('REMOVING_FROM_SQUAD', async () => {
			const squadLabel = playerInfo?.squadName ? `"${playerInfo.squadName}"` : 'their squad'
			const result = await openDialog({
				title: 'Remove from Squad',
				description: `Remove this player from ${squadLabel}?`,
				content: <ReasonPicker action="remove-from-squad" presetRef={presetReasonRef} required={removeReasonRequired} />,
				buttons: [{ id: 'confirm', label: 'Remove' }],
			})
			if (result !== 'confirm') return
			const input = SquadServerClient.readReasonInput({
				action: 'remove-from-squad',
				required: removeReasonRequired,
				presetRef: presetReasonRef,
			})
			if (!input) return
			await removeFromSquadMutation.mutateAsync({ serverId, playerId, presetReasonLabel: input.presetReasonLabel })
		})
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		if (playerInfo?.squadId === null || playerInfo?.squadId === undefined || !playerInfo.teamId) return
		const { squadId, teamId, squadName } = playerInfo
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('DISBANDING_SQUAD', async () => {
			const squadLabel = squadName ? `"${squadName}"` : `squad ${squadId}`
			const result = await openDialog({
				title: 'Disband Squad',
				description: `Disband ${squadLabel} on team ${teamId}?`,
				content: <ReasonPicker action="disband-squad" presetRef={presetReasonRef} required={disbandReasonRequired} />,
				buttons: [{ id: 'confirm', label: 'Disband' }],
			})
			if (result !== 'confirm') return
			const input = SquadServerClient.readReasonInput({
				action: 'disband-squad',
				required: disbandReasonRequired,
				presetRef: presetReasonRef,
			})
			if (!input) return
			await disbandSquadMutation.mutateAsync({
				serverId,
				teamId: teamId as 1 | 2,
				squadId,
				presetReasonLabel: input.presetReasonLabel,
			})
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
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('DEMOTING_COMMANDER', async () => {
			const result = await openDialog({
				title: 'Demote Commander',
				description: 'Demote this player from commander?',
				content: <ReasonPicker action="demote-commander" presetRef={presetReasonRef} required={demoteReasonRequired} />,
				buttons: [{ id: 'confirm', label: 'Demote' }],
			})
			if (result !== 'confirm') return
			const input = SquadServerClient.readReasonInput({
				action: 'demote-commander',
				required: demoteReasonRequired,
				presetRef: presetReasonRef,
			})
			if (!input) return
			await demoteCommanderMutation.mutateAsync({ serverId, playerId, presetReasonLabel: input.presetReasonLabel })
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
							SquadServerFrame.Actions.selectSquad(stores, playerId)
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
						SquadServerFrame.Actions.selectAllWithRole(stores, playerInfo.role, teamId)
					}}
				>
					Role{playerInfo?.role != null ? ` (${playerInfo.role})` : ''}
					<ContextMenuShortcut>{sc('⇧+click role cell', '⇧+Ctrl+click role cell')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={group == null || teamMissing}
					onClick={() => {
						if (group == null) return
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectGroup(stores, group, teamId)
					}}
				>
					Group{group != null ? ` (${group})` : ''}
					<ContextMenuShortcut>{sc('⇧+click group cell', '⇧+Ctrl+click group cell')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!playerInfo?.isLeader || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllSquadLeaders(stores, teamId)
					}}
				>
					Squad Leaders
				</Item>
				<Item
					disabled={!playerInfo?.isAdmin || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllAdmins(stores, teamId)
					}}
				>
					Admins
					<ContextMenuShortcut>{sc('⇧+click admin badge', '⇧+Ctrl+click admin badge')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!isOnServer || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllTeamPlayers(stores, teamId)
					}}
				>
					All Players
					<ContextMenuShortcut>{sc('⇧+click select-all box', '⇧+Ctrl+click select-all box')}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.invertSelection(stores, teamId)
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
					onClick={() => TSWClient.Actions.swapNext(stores, [playerId])}
					disabled={!!manageDenied || !otherTeam || !canQueue}
				>
					Swap Next
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={swapNow}
					disabled={!!manageDenied || !otherTeam || !canSwapNow}
				>
					Swap Now
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kill}
					disabled={!!manageDenied || !otherTeam || !canSwapNow}
				>
					Kill
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={kickDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kick}
					disabled={!!kickDenied || !isOnServer}
				>
					Kick
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={timeoutDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={timeout}
					disabled={!!timeoutDenied || !isOnServer}
				>
					Timeout
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.removeSwap(stores, [playerId])}
					disabled={!!manageDenied || !existingSwap}
				>
					Delete Swap
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			{!omitWarn && <WarnReasonsSub slots={slots} denied={warnDenied} disabled={!isOnServer} onCustom={warn} onPreset={sendPresetWarn} />}
			<PlayerFlagsSub slots={slots} playerId={playerId} />
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
