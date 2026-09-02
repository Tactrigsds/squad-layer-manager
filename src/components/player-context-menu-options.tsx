import { useQuery } from '@tanstack/react-query'
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
import * as RPC from '@/orpc.client'
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

// An entry that cannot be served at all -- no live player behind the menu, no squad, no swap queued -- is
// left out rather than greyed. A permission denial is not that: the entry stays, disabled, so its tooltip can
// say which permission is missing.
type MenuEntry = React.ReactElement | false | null | undefined

function present(entries: MenuEntry[]): React.ReactElement[] {
	return entries.filter((entry): entry is React.ReactElement => !!entry)
}

type MenuSection = { key: string; items: MenuEntry[] }

// Separators go between the sections that still have entries, so dropping a whole section leaves no rule
// behind and no two rules in a row.
function MenuSections({ sections, Separator }: { sections: MenuSection[]; Separator: MenuSlots['Separator'] }) {
	const filled = sections.map((section) => ({ ...section, items: present(section.items) })).filter((section) => section.items.length > 0)
	return (
		<>
			{filled.map((section, index) => (
				<React.Fragment key={section.key}>
					{index > 0 && <Separator />}
					{section.items}
				</React.Fragment>
			))}
		</>
	)
}

const DESTRUCTIVE_ITEM = 'bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600'

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

function useFramedPlayerLinkIds(playerIds: SM.PlayerId[], stores: SquadServerFrame.KeyProp): PlayerLinkIds[] {
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

// The same facts off any server: what the db recorded about the player, plus their battlemetrics profile.
// One player rather than a list, because the frameless menu only ever opens on a single row.
function useFramelessPlayerLinkIds(playerId: SM.PlayerId): PlayerLinkIds[] {
	const { data: info } = useQuery(RPC.orpc.history.playerInfo.queryOptions({ input: { playerId } }))
	const { data: bmData } = useQuery(RPC.orpc.battlemetrics.getPlayerBmData.queryOptions({ input: { playerId }, staleTime: Infinity }))
	return React.useMemo(() => {
		const known = info?.code === 'ok' ? info : undefined
		return [
			{
				eos: playerId,
				username: known?.username ?? undefined,
				steam: known?.steamId ?? bmData?.playerIds.steam,
				bmProfileUrl: bmData?.profileUrl,
			},
		]
	}, [playerId, info, bmData])
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
	const players = useFramedPlayerLinkIds(playerIds, stores)
	return <OpenLinksSubView players={players} slots={slots} />
}

function FramelessOpenLinksSub({ playerId, slots }: { playerId: SM.PlayerId; slots: MenuSlots }) {
	const players = useFramelessPlayerLinkIds(playerId)
	return <OpenLinksSubView players={players} slots={slots} />
}

function OpenLinksSubView({ players, slots }: { players: PlayerLinkIds[]; slots: MenuSlots }) {
	const { Item, Sub, SubTrigger, SubContent } = slots
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
	// a link nobody in the selection has an id for is dropped, and with every link dropped the submenu goes too
	const available = links.filter(({ urls }) => urls.length > 0)
	if (available.length === 0) return null
	return (
		<Sub>
			<SubTrigger>{tr.text(SM_Msgs.openLinks())}</SubTrigger>
			<SubContent>
				{available.map(({ label, urls }) => (
					<Item key={label} onClick={() => openAll(urls)}>
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
	const players = useFramedPlayerLinkIds(playerIds, stores)
	return <CopyIdsSubView players={players} slots={slots} />
}

function FramelessCopyIdsSub({ playerId, slots }: { playerId: SM.PlayerId; slots: MenuSlots }) {
	const players = useFramelessPlayerLinkIds(playerId)
	return <CopyIdsSubView players={players} slots={slots} />
}

function CopyIdsSubView({ players, slots }: { players: PlayerLinkIds[]; slots: MenuSlots }) {
	const { Item, Sub, SubTrigger, SubContent } = slots
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
	const available = ids.filter(({ values }) => values.length > 0)
	if (available.length === 0) return null
	return (
		<Sub>
			<SubTrigger>{tr.text(SM_Msgs.copyIds())}</SubTrigger>
			<SubContent>
				{available.map(({ label, values }) => (
					<Item key={label} onClick={() => copyAll(label, values)}>
						{label}
						{players.length > 1 ? 's' : ''}
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

export function PlayerMenuItems(props: {
	playerId: SM.PlayerId
	slots: MenuSlots
	// absent where the menu was opened somewhere no server frame reaches: a history results row, whose
	// players span servers and matches. See FramelessPlayerMenuItems for what survives that.
	stores?: SquadServerFrame.KeyProp
	// hidden inside the player details window, which has its own warn box at the bottom
	omitWarn?: boolean
}) {
	if (!props.stores) return <FramelessPlayerMenuItems playerId={props.playerId} slots={props.slots} />
	return <FramedPlayerMenuItems {...props} stores={props.stores} />
}

// Off a server there is no roster to select against, no rcon to act through and no server to scope a
// permission to, so every action the framed menu leads with is meaningless. What is left is who the player
// is, which is the same everywhere.
function FramelessPlayerMenuItems({ playerId, slots }: { playerId: SM.PlayerId; slots: MenuSlots }) {
	return (
		<MenuSections
			Separator={slots.Separator}
			sections={[
				{
					key: 'identity',
					items: [
						<FramelessOpenLinksSub key="links" playerId={playerId} slots={slots} />,
						<FramelessCopyIdsSub key="ids" playerId={playerId} slots={slots} />,
						<PlayerFlagsMenuItem key="flags" slots={slots} playerId={playerId} />,
					],
				},
			]}
		/>
	)
}

function FramedPlayerMenuItems({
	playerId,
	slots,
	stores,
	omitWarn,
}: {
	playerId: SM.PlayerId
	slots: MenuSlots
	stores: SquadServerFrame.KeyProp
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
			const player = SM.PlayerIds.find(ChatPrt.Sel.players(chatStore), (p) => p.ids, playerId)
			if (!player?.teamId) return null
			const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
			const id = normed === 'A' ? 'B' : 'A'
			return { id, faction: MH.getNormedTeamFaction(currentMatch, id) }
		},
	)

	const playerInfo = Zus.useStore(stores.squadServer, (chatStore: ChatPrt.Store) => {
		const players = ChatPrt.Sel.players(chatStore)
		const squads = ChatPrt.Sel.squads(chatStore)
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
			const player = SM.PlayerIds.find(ChatPrt.Sel.players(chatStore), (p) => p.ids, playerId)
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

	// The select-type items for a given scope: 'team' selects only the clicked player's team, 'all' selects
	// across both teams. The Squad item only appears under 'team' since a squad belongs to a single team.
	function selectItems(scope: 'team' | 'all'): React.ReactElement[] {
		const teamId = scope === 'team' ? (playerInfo?.teamId ?? undefined) : undefined
		if (scope === 'team' && playerInfo?.teamId == null) return []
		const sc = (pair: { team: string; all: string }) => (scope === 'team' ? pair.team : pair.all)
		return present([
			scope === 'team' && inSquad && (
				<Item
					key="squad"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectSquad(stores, playerId)
					}}
				>
					{tr.text(SM_Msgs.selectSquad(playerInfo?.squadName ?? undefined))}
					<ContextMenuShortcut>{SM_Msgs.shortcuts.squadCell.team}</ContextMenuShortcut>
				</Item>
			),
			playerInfo?.role != null && (
				<Item
					key="role"
					onClick={() => {
						if (playerInfo?.role == null) return
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllWithRole(stores, playerInfo.role, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectRole(playerInfo.role))}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.roleCell)}</ContextMenuShortcut>
				</Item>
			),
			group != null && (
				<Item
					key="group"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectGroup(stores, group, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectGroup(group))}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.groupCell)}</ContextMenuShortcut>
				</Item>
			),
			playerInfo?.isLeader && (
				<Item
					key="leaders"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllSquadLeaders(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectSquadLeaders())}
				</Item>
			),
			playerInfo?.isAdmin && (
				<Item
					key="admins"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllAdmins(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectAdmins())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.adminBadge)}</ContextMenuShortcut>
				</Item>
			),
			playerInfo?.inAdminCam && (
				<Item
					key="admin-cam"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllInAdminCam(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectInAdminCam())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.cameraIcon)}</ContextMenuShortcut>
				</Item>
			),
			isOnServer && (
				<Item
					key="all-players"
					onClick={() => {
						TSWClient.Actions.ensureViewingTeams(serverId)
						SquadServerFrame.Actions.selectAllTeamPlayers(stores, teamId)
					}}
				>
					{tr.text(SM_Msgs.selectAllPlayers())}
					<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.selectAllBox)}</ContextMenuShortcut>
				</Item>
			),
			<Item
				key="invert"
				onClick={() => {
					TSWClient.Actions.ensureViewingTeams(serverId)
					SquadServerFrame.Actions.invertSelection(stores, teamId)
				}}
			>
				{tr.text(SM_Msgs.invert())}
				<ContextMenuShortcut>{sc(SM_Msgs.shortcuts.invertBox)}</ContextMenuShortcut>
			</Item>,
		])
	}

	function selectSub(key: string, label: string, scope: 'team' | 'all') {
		const items = selectItems(scope)
		if (items.length === 0) return null
		return (
			<Sub key={key}>
				<SubTrigger>{label}</SubTrigger>
				<SubContent>{items}</SubContent>
			</Sub>
		)
	}

	const sections: MenuSection[] = [
		{
			key: 'swap-next',
			items: [
				otherTeam && (
					<PermissionDeniedTooltip key="swap-next" denied={manageDenied}>
						<Item onClick={() => TSWClient.Actions.swapNext(stores, [playerId])} disabled={!!manageDenied || !canQueue}>
							{tr.text(SM_Msgs.swapNextLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
			],
		},
		{
			key: 'destructive',
			items: [
				otherTeam && (
					<PermissionDeniedTooltip key="swap-now" denied={manageDenied}>
						<Item className={DESTRUCTIVE_ITEM} onClick={swapNow} disabled={!!manageDenied || !canSwapNow}>
							{tr.text(SM_Msgs.swapNowLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
				otherTeam && (
					<PermissionDeniedTooltip key="kill" denied={manageDenied}>
						<Item className={DESTRUCTIVE_ITEM} onClick={kill} disabled={!!manageDenied || !canSwapNow}>
							{tr.text(SM_Msgs.killLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
				isOnServer && (
					<PermissionDeniedTooltip key="kick" denied={kickDenied}>
						<Item className={DESTRUCTIVE_ITEM} onClick={kick} disabled={!!kickDenied}>
							{tr.text(SM_Msgs.kickLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
				isOnServer && (
					<PermissionDeniedTooltip key="timeout" denied={timeoutDenied}>
						<Item className={DESTRUCTIVE_ITEM} onClick={timeout} disabled={!!timeoutDenied}>
							{tr.text(SM_Msgs.timeoutLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
			],
		},
		{
			key: 'swaps',
			items: [
				existingSwap && (
					<PermissionDeniedTooltip key="delete-swap" denied={manageDenied}>
						<Item onClick={() => TSWClient.Actions.removeSwap(stores, [playerId])} disabled={!!manageDenied}>
							{tr.text(SM_Msgs.deleteSwapLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
			],
		},
		{
			key: 'player',
			items: [
				!omitWarn && isOnServer && (
					<WarnReasonsSub key="warn" slots={slots} denied={warnDenied} onCustom={warn} onPreset={warnPreset} />
				),
				isOnServer && (
					<Item key="teleport" onClick={copyTeleportCommand}>
						{tr.text(SM_Msgs.copyTeleportCommand())}
					</Item>
				),
			],
		},
		{
			// the flags item rides here rather than in a section of its own: it renders nothing where
			// battlemetrics is off, which a section counting its entries cannot see, and this one always has the
			// two id subs to keep it from emptying
			key: 'identity',
			items: [
				<PlayerOpenLinksSub key="links" playerIds={[playerId]} slots={slots} stores={stores} />,
				<PlayerCopyIdsSub key="ids" playerIds={[playerId]} slots={slots} stores={stores} />,
				<PlayerFlagsMenuItem key="flags" slots={slots} playerId={playerId} />,
			],
		},
		{
			key: 'select',
			items: [
				isOnServer && selectSub('from-team', tr.text(SM_Msgs.selectFromTeam()), 'team'),
				isOnServer && selectSub('all', tr.text(SM_Msgs.selectAll()), 'all'),
			],
		},
		{
			key: 'squad',
			items: [
				inSquad && (
					<PermissionDeniedTooltip key="remove-from-squad" denied={manageDenied}>
						<Item onClick={removeFromSquad} disabled={!!manageDenied}>
							{tr.text(SM_Msgs.removeFromSquadLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
				inSquad && (
					<PermissionDeniedTooltip key="disband-squad" denied={manageDenied}>
						<Item onClick={disbandSquad} disabled={!!manageDenied}>
							{tr.text(SM_Msgs.disbandSquadLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
				inSquad && (
					<PermissionDeniedTooltip key="reset-squad-name" denied={manageDenied}>
						<Item onClick={resetSquadName} disabled={!!manageDenied}>
							{tr.text(SM_Msgs.resetSquadNameLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
			],
		},
		{
			key: 'commander',
			items: [
				playerInfo?.isCommander && (
					<PermissionDeniedTooltip key="demote-commander" denied={manageDenied}>
						<Item onClick={demoteCommander} disabled={!!manageDenied}>
							{tr.text(SM_Msgs.demoteCommanderLabel())}
						</Item>
					</PermissionDeniedTooltip>
				),
			],
		},
	]

	return <MenuSections sections={sections} Separator={Separator} />
}

export default function PlayerContextMenuOptions({ playerId, stores }: { playerId: SM.PlayerId; stores?: SquadServerFrame.KeyProp }) {
	return <PlayerMenuItems playerId={playerId} slots={contextMenuSlots} stores={stores} />
}
