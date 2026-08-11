import React from 'react'

import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import type * as Tgt from '@/messages/target'
import * as TSW_Msgs from '@/messages/teamswaps.messages'
import type * as BM from '@/models/battlemetrics.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UPClient from '@/systems/user-presence.client'
import * as WarnChat from '@/systems/warn-chat.client'

import { PlayerFlagsMenuItem } from './bm-flag-workflows'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from './ui/context-menu'
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
	return Zus.useStore(
		stores.squadServer,
		BattlemetricsClient.playerBmData$,
		(chatStore: ChatPrt.Store, bmData: BM.PublicPlayerBmData): PlayerLinkIds[] =>
			playerIds.map((playerId) => {
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

export function PlayerOpenLinksSub({
	playerIds,
	slots,
	stores,
}: {
	playerIds: SM.PlayerId[]
	slots: MenuSlots
	stores: SquadServerFrame.KeyProp
}) {
	const { Item, Sub, SubTrigger, SubContent } = slots
	const players = usePlayerLinkIds(playerIds, stores)
	const openAll = (urls: string[]) => {
		for (const url of urls) window.open(url, '_blank', 'noopener,noreferrer')
	}
	const steamIds = players.map((p) => p.steam).filter((s): s is string => s != null)
	const bmUrls = players.map((p) => p.bmProfileUrl ?? bmSearchUrl(p.eos))
	const links: { label: string; urls: string[] }[] = [
		{ label: SM_Msgs.linkNames.steam, urls: steamIds.map((id) => `https://steamcommunity.com/profiles/${id}`) },
		{ label: SM_Msgs.linkNames.cbl, urls: steamIds.map((id) => `https://communitybanlist.com/search/${id}`) },
		{ label: SM_Msgs.linkNames.mySquadStats, urls: steamIds.map((id) => `https://mysquadstats.com/search/${id}#vanillaStats`) },
		{ label: SM_Msgs.linkNames.battlemetrics, urls: bmUrls },
	]
	return (
		<Sub>
			<SubTrigger>{tr.text(SM_Msgs.openLinks())}</SubTrigger>
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

export function PlayerCopyIdsSub({
	playerIds,
	slots,
	stores,
}: {
	playerIds: SM.PlayerId[]
	slots: MenuSlots
	stores: SquadServerFrame.KeyProp
}) {
	const { Item, Sub, SubTrigger, SubContent } = slots
	const players = usePlayerLinkIds(playerIds, stores)
	const pickAll = (pick: (p: PlayerLinkIds) => string | undefined) => players.map(pick).filter((v): v is string => v != null)
	const ids: { label: string; values: string[] }[] = [
		{ label: SM_Msgs.idNames.username, values: pickAll((p) => p.username) },
		{ label: SM_Msgs.idNames.eos, values: pickAll((p) => p.eos) },
		{ label: SM_Msgs.idNames.steam, values: pickAll((p) => p.steam) },
		{ label: SM_Msgs.idNames.epic, values: pickAll((p) => p.epic) },
	]
	const copyAll = (label: string, values: string[]) => {
		void navigator.clipboard.writeText(values.join('\n'))
		toast(...tr.toast(SM_Msgs.copiedToClipboard(label, values.length)))
	}
	return (
		<Sub>
			<SubTrigger>{tr.text(SM_Msgs.copyIds())}</SubTrigger>
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
export function TimeoutDialogContent({
	durationRef,
	customReasonRef,
	presetReasonRef,
	maxTimeout,
	required,
	squadName,
}: {
	durationRef: React.MutableRefObject<string>
	customReasonRef: React.MutableRefObject<string>
	presetReasonRef: React.MutableRefObject<string>
	maxTimeout: number | null | undefined
	required?: boolean
	// for squad timeouts: the target squad's name, forwarded to the reason preview
	squadName?: string
}) {
	const [durationText, setDurationText] = React.useState(() => durationRef.current)
	const durationMs = ZodUtils.tryParseHumanTimeToken(durationText.trim())
	return (
		<div className="grid gap-3 py-2">
			<div className="grid gap-2">
				<Label htmlFor="timeout-duration">{tr.text(SM_Msgs.timeoutDurationLabel())}</Label>
				<Input
					id="timeout-duration"
					autoComplete="off"
					placeholder={tr.text(
						SM_Msgs.timeoutDurationPlaceholder(maxTimeout == null ? undefined : ZodUtils.formatHumanTime(maxTimeout)),
					)}
					defaultValue={durationRef.current}
					onChange={(e) => {
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
				squadName={squadName}
				autoOpen={false}
			/>
		</div>
	)
}

export function PlayerMenuItems({
	playerId,
	slots,
	stores,
	omitWarn,
}: {
	playerId: SM.PlayerId
	slots: MenuSlots
	stores: SquadServerFrame.KeyProp
	// hidden inside the player details window, which has its own warn box at the bottom
	omitWarn?: boolean
}) {
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

	const serverId = stores.squadServer.serverId
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const kickMutation = SquadServerClient.useKickPlayersMutation()
	const timeoutMutation = TimeoutsClient.useTimeoutPlayerMutation()
	const maxTimeout = TimeoutsClient.useMaxTimeout(serverId)
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

	const otherTeam = Zus.useStore(
		stores.squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		(chatStore: ChatPrt.Store, currentMatch: MH.MatchDetails | undefined): { id: MH.NormedTeamId; faction?: string } | null => {
			if (!currentMatch) return null
			const player = SM.PlayerIds.find(ChatPrt.Sel.chatState(chatStore).players, (p) => p.ids, playerId)
			if (!player?.teamId) return null
			const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
			const id = normed === 'A' ? 'B' : 'A'
			return { id, faction: MH.getNormedTeamFaction(currentMatch, id) }
		},
	)

	const playerInfo = Zus.useStore(stores.squadServer, (chatStore: ChatPrt.Store) => {
		const players = ChatPrt.Sel.chatState(chatStore).players
		const squads = ChatPrt.Sel.chatState(chatStore).squads
		const player = SM.PlayerIds.find(players, (p) => p.ids, playerId)
		if (!player) return null
		const squad = player.squadId !== null ? squads.find((s) => s.squadId === player.squadId && s.teamId === player.teamId) : undefined
		return {
			squadId: player.squadId,
			teamId: player.teamId,
			username: player.ids.username,
			role: player.role,
			squadName: squad?.squadName ?? null,
			isCommander: player.isLeader && squad?.squadName === 'Command Squad',
			isLeader: player.isLeader,
			isAdmin: player.isAdmin,
			inAdminCam: ChatPrt.Sel.chatState(chatStore).adminCamPlayerIds.includes(playerId),
		}
	})

	const group = Zus.useStore(
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
			const player = SM.PlayerIds.find(ChatPrt.Sel.chatState(chatStore).players, (p) => p.ids, playerId)
			if (player?.teamId == null) return undefined
			const enriched = TeamsPanelModels.Sel.playersForTeam(player.teamId)(chatStore, currentMatch, bmData, bmStore, settings)
			return SM.PlayerIds.find(enriched, (p) => p.ids, playerId)?.group
		},
	)

	const msgTarget: Tgt.Target = { kind: 'player', username: playerInfo?.username }

	const existingSwap = Zus.useStore(stores.squadServer, (s) => TSWClient.Sel.localState(s).editedSwaps.get(playerId) ?? null)

	const canSwapNow = Zus.useStore(stores.squadServer, TSWClient.Sel.canSwapNow([playerId]))
	const canQueue = Zus.useStore(stores.squadServer, TSWClient.Sel.canQueue([playerId]))

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId: serverId }))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players', { serverId: serverId }))
	const kickDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:kick-players', { serverId: serverId }))
	const timeoutDenied = RbacClient.usePermsCheck(SM.Grants.anyTimeout(serverId))

	async function swapNow() {
		if (!otherTeam) return
		const initialTeam = TSWClient.Sel.localState(Zus.getState(stores.squadServer)).players.get(playerId)
		const unsubscribe = Zus.resolveReadStore(stores.squadServer).subscribe((state) => {
			if (TSWClient.Sel.localState(state).players.get(playerId) !== initialTeam) closeDialog()
		})
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
				const msg = tr.confirm(TSW_Msgs.swapNow(msgTarget, TSW_Msgs.destination(otherTeam.id, otherTeam.faction)))
				const result = await openDialog({
					title: msg.title,
					variant: 'destructive',
					description: msg.description,
					buttons: [{ id: 'confirm', label: msg.confirmLabel }],
				})
				if (result === 'dismissed') {
					toast.warning(...tr.toast(TSW_Msgs.swapCancelled(msgTarget)))
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
			const msg = tr.confirm(SM_Msgs.kill(msgTarget))
			const result = await openDialog({
				title: msg.title,
				variant: 'destructive',
				description: msg.description,
				content: (
					<div className="grid gap-3 py-2">
						<ReasonPicker action="kill" presetRef={presetReasonRef} customRef={customReasonRef} required={killReasonRequired} />
					</div>
				),
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
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
				toast.error(...tr.toast(SM_Msgs.killFailed('msg' in res && res.msg ? res.msg : res.code)))
				return
			}
			toast(...tr.toast(SM_Msgs.kill(msgTarget)))
		})
	}

	async function kick() {
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const msg = tr.confirm(SM_Msgs.kick(msgTarget))
			const result = await openDialog({
				title: msg.title,
				variant: 'destructive',
				description: msg.description,
				content: (
					<div className="grid gap-3 py-2">
						<ReasonPicker action="kick" presetRef={presetReasonRef} customRef={customReasonRef} required={kickReasonRequired} />
					</div>
				),
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
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
				toast.error(...tr.toast(SM_Msgs.kickFailed('msg' in res && res.msg ? res.msg : res.code)))
				return
			}
			toast(...tr.toast(SM_Msgs.kick(msgTarget)))
		})
	}

	async function timeout() {
		timeoutDurationRef.current = ''
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const msg = tr.confirm(SM_Msgs.timeout(msgTarget))
			const result = await openDialog({
				title: msg.title,
				variant: 'destructive',
				description: msg.description,
				content: (
					<TimeoutDialogContent
						durationRef={timeoutDurationRef}
						customReasonRef={customReasonRef}
						presetReasonRef={presetReasonRef}
						maxTimeout={maxTimeout}
						required={timeoutReasonRequired}
					/>
				),
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
			})
			if (result !== 'confirm') return
			const durationMs = ZodUtils.tryParseHumanTimeToken(timeoutDurationRef.current.trim())
			if (durationMs === undefined) {
				toast.error(...tr.toast(SM_Msgs.invalidTimeoutDuration()))
				return
			}
			if (typeof maxTimeout === 'number' && durationMs > maxTimeout) {
				toast.error(...tr.toast(SM_Msgs.timeoutTooLong(ZodUtils.formatHumanTime(maxTimeout))))
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
				toast.error(...tr.toast(SM_Msgs.timeoutFailed('msg' in res && res.msg ? res.msg : res.code)))
				return
			}
			toast(...tr.toast(SM_Msgs.timedOut(msgTarget, ZodUtils.formatHumanTime(durationMs))))
		})
	}

	// open (or raise) the player's details window and focus its warn box, rather than a one-off dialog
	function warn() {
		openOrFocusWindow(WINDOW_ID.enum['player-details'], { playerId, stores })
		WarnChat.requestWarnFocus({ kind: 'player', playerId })
	}

	async function warnPreset() {
		presetReasonRef.current = ''
		const msg = tr.confirm(SM_Msgs.warnPreset(msgTarget))
		const result = await openDialog({
			title: msg.title,
			description: msg.description,
			content: (
				<div className="grid gap-3 py-2">
					<ReasonPicker action="warn" presetRef={presetReasonRef} required />
				</div>
			),
			buttons: [{ id: 'confirm', label: msg.confirmLabel }],
		})
		if (result !== 'confirm') return
		const input = SquadServerClient.readReasonInput({ action: 'warn', required: true, presetRef: presetReasonRef })
		if (!input) return
		const res = await warnPlayersMutation.mutateAsync({ serverId, playerIds: [playerId], ...input })
		if (res.code !== 'ok') {
			toast.error(...tr.toast(SM_Msgs.warnFailed('msg' in res ? res.msg : res.code)))
			return
		}
		toast(...tr.toast(SM_Msgs.warned(msgTarget, presetReasonRef.current)))
	}

	function copyTeleportCommand() {
		void navigator.clipboard.writeText(`AdminTeleportToPlayer ${playerId}`)
		toast(...tr.toast(SM_Msgs.copiedToClipboard('Teleport command')))
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('REMOVING_FROM_SQUAD', async () => {
			const msg = tr.confirm(SM_Msgs.removeFromSquad(msgTarget, playerInfo?.squadName ? `"${playerInfo.squadName}"` : undefined))
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				content: <ReasonPicker action="remove-from-squad" presetRef={presetReasonRef} required={removeReasonRequired} />,
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
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
			const msg = tr.confirm(SM_Msgs.disbandSquad(squadName ? `"${squadName}"` : `squad ${squadId}`, teamId))
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				content: (
					<ReasonPicker
						action="disband-squad"
						presetRef={presetReasonRef}
						required={disbandReasonRequired}
						squadName={squadName ?? undefined}
					/>
				),
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
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
			const msg = tr.confirm(SM_Msgs.resetSquadName(squadName ? `"${squadName}"` : `squad ${squadId}`))
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
			})
			if (result !== 'confirm') return
			await resetSquadNameMutation.mutateAsync({ serverId, teamId: teamId as 1 | 2, squadId })
		})
	}

	async function demoteCommander() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('DEMOTING_COMMANDER', async () => {
			const msg = tr.confirm(SM_Msgs.demoteCommander())
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				content: <ReasonPicker action="demote-commander" presetRef={presetReasonRef} required={demoteReasonRequired} />,
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
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
		const sc = (pair: { team: string; all: string }) => (scope === 'team' ? pair.team : pair.all)
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
						{tr.text(SM_Msgs.selectSquad(playerInfo?.squadName ?? undefined))}
						<ContextMenuShortcut>{SM_Msgs.shortcuts.squadCell.team}</ContextMenuShortcut>
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
					{tr.text(SM_Msgs.selectRole(playerInfo?.role ?? undefined))}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.roleCell)}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={group == null || teamMissing}
					onClick={() => {
						if (group == null) return
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectGroup(stores, group, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectGroup(group ?? undefined))}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.groupCell)}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!playerInfo?.isLeader || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllSquadLeaders(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectSquadLeaders())}
				</Item>
				<Item
					disabled={!playerInfo?.isAdmin || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllAdmins(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectAdmins())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.adminBadge)}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!playerInfo?.inAdminCam || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllInAdminCam(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectInAdminCam())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.cameraIcon)}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={!isOnServer || teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllTeamPlayers(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectAllPlayers())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.selectAllBox)}</ContextMenuShortcut>
				</Item>
				<Item
					disabled={teamMissing}
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.invertSelection(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.invert())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.invertBox)}</ContextMenuShortcut>
				</Item>
			</>
		)
	}

	return (
		<>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={() => TSWClient.Actions.swapNext(stores, [playerId])} disabled={!!manageDenied || !otherTeam || !canQueue}>
					{tr.text(SM_Msgs.swapNextLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={swapNow}
					disabled={!!manageDenied || !otherTeam || !canSwapNow}
				>
					{tr.text(SM_Msgs.swapNowLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kill}
					disabled={!!manageDenied || !otherTeam || !canSwapNow}
				>
					{tr.text(SM_Msgs.killLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={kickDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kick}
					disabled={!!kickDenied || !isOnServer}
				>
					{tr.text(SM_Msgs.kickLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={timeoutDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={timeout}
					disabled={!!timeoutDenied || !isOnServer}
				>
					{tr.text(SM_Msgs.timeoutLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={() => TSWClient.Actions.removeSwap(stores, [playerId])} disabled={!!manageDenied || !existingSwap}>
					{tr.text(SM_Msgs.deleteSwapLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			{!omitWarn && <WarnReasonsSub slots={slots} denied={warnDenied} disabled={!isOnServer} onCustom={warn} onPreset={warnPreset} />}
			<PlayerFlagsMenuItem slots={slots} playerId={playerId} />
			<Item onClick={copyTeleportCommand} disabled={!isOnServer}>
				{tr.text(SM_Msgs.copyTeleportCommand())}
			</Item>
			<Separator />
			<PlayerOpenLinksSub playerIds={[playerId]} slots={slots} stores={stores} />
			<PlayerCopyIdsSub playerIds={[playerId]} slots={slots} stores={stores} />
			<Separator />
			<Sub>
				<SubTrigger disabled={!isOnServer}>{tr.text(SM_Msgs.selectFromTeam())}</SubTrigger>
				<SubContent>{selectItems('team')}</SubContent>
			</Sub>
			<Sub>
				<SubTrigger disabled={!isOnServer}>{tr.text(SM_Msgs.selectAll())}</SubTrigger>
				<SubContent>{selectItems('all')}</SubContent>
			</Sub>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={removeFromSquad} disabled={!!manageDenied || !inSquad}>
					{tr.text(SM_Msgs.removeFromSquadLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={disbandSquad} disabled={!!manageDenied || !inSquad}>
					{tr.text(SM_Msgs.disbandSquadLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={resetSquadName} disabled={!!manageDenied || !inSquad}>
					{tr.text(SM_Msgs.resetSquadNameLabel())}
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={demoteCommander} disabled={!!manageDenied || !playerInfo?.isCommander}>
					{tr.text(SM_Msgs.demoteCommanderLabel())}
				</Item>
			</PermissionDeniedTooltip>
		</>
	)
}

export default function PlayerContextMenuOptions({ playerId, stores }: { playerId: SM.PlayerId; stores: SquadServerFrame.KeyProp }) {
	return <PlayerMenuItems playerId={playerId} slots={contextMenuSlots} stores={stores} />
}
