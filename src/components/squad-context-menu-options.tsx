import React from 'react'

import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import type * as Msgs from '@/messages/shared'
import * as SM_Msgs from '@/messages/squad.messages'
import * as TSW_Msgs from '@/messages/teamswaps.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UPClient from '@/systems/user-presence.client'
import * as WarnChat from '@/systems/warn-chat.client'

import { AddPlayerFlagsMenuItem } from './bm-flag-workflows'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { type MenuSlots, TimeoutDialogContent } from './player-context-menu-options'
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'
import { ReasonPicker, WarnReasonsSub } from './warn-reasons-sub'

const contextMenuSlots: MenuSlots = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

export function SquadMenuItems({
	squad,
	slots,
	stores,
	omitWarn,
}: {
	squad: Pick<SM.Squad, 'squadId' | 'teamId' | 'squadName'>
	slots: MenuSlots
	stores: SquadServerFrame.KeyProp
	// hidden inside the squad details window, which has its own warn box at the bottom
	omitWarn?: boolean
}) {
	const { Item, Separator } = slots
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const openOrFocusWindow = useOpenOrFocusWindow()
	// holds the preset-reason pick in the disband/kill/kick/timeout dialogs; the alert dialog only resolves a button
	// id and unmounts its content on confirm, so the pick is read from here
	const presetReasonRef = React.useRef('')
	const customReasonRef = React.useRef('')
	const timeoutDurationRef = React.useRef('')

	const disbandReasonRequired = SettingsClient.useReasonRequired('disband-squad')
	const killReasonRequired = SettingsClient.useReasonRequired('kill')
	const kickReasonRequired = SettingsClient.useReasonRequired('kick')
	const timeoutReasonRequired = SettingsClient.useReasonRequired('timeout')
	const serverId = stores.squadServer.serverId
	const disbandSquadMutation = SquadServerClient.useDisbandSquadMutation()
	const resetSquadNameMutation = SquadServerClient.useResetSquadNameMutation()
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const killMutation = SquadServerClient.useKillMutation()
	const kickMutation = SquadServerClient.useKickPlayersMutation()
	const timeoutMutation = TimeoutsClient.useTimeoutPlayerMutation()
	const maxTimeout = TimeoutsClient.useMaxTimeout(serverId)

	// uniqueId isn't on the passed-in squad prop, so resolve it (and live membership) from chat state; it's
	// null when the squad isn't currently live, in which case there's nothing to warn
	const { squadPlayerIds, squadExists, uniqueId } = Zus.useStore(stores.squadServer, (chatStore: ChatPrt.Store) => {
		const state = ChatPrt.Sel.chatState(chatStore)
		const liveSquad = state.squads.find((s) => s.squadId === squad.squadId && s.teamId === squad.teamId)
		const squadPlayerIds = state.players
			.filter((p) => p.squadId === squad.squadId && p.teamId === squad.teamId)
			.map((p) => SM.PlayerIds.getPlayerId(p.ids))
		return { squadPlayerIds, squadExists: !!liveSquad, uniqueId: liveSquad?.uniqueId ?? null }
	})

	const canSwapNow = Zus.useStore(stores.squadServer, TSWClient.Sel.canSwapNow(squadPlayerIds))
	const canQueue = Zus.useStore(stores.squadServer, TSWClient.Sel.canQueue(squadPlayerIds))
	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId: serverId }))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players', { serverId: serverId }))
	const kickDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:kick-players', { serverId: serverId }))
	// timeout grants are comparator-matched (see useMaxTimeout), so the denial is synthesized rather than
	// coming from usePermsCheck
	const timeoutDenied = maxTimeout === undefined ? RBAC.permissionDenied('all', ['squad-server:timeout-players']) : null

	const squadLabel = `"${squad.squadName}"`
	const teamId = squad.teamId as 1 | 2
	const msgTarget: Msgs.Target = { kind: 'squad', squadName: squad.squadName, count: squadPlayerIds.length }

	// mirrors the player/bulk Swap Now flow: confirm, then swap. The dialog auto-closes if any member changes
	// teams while it's open (their swap would be a no-op or wrong), warning the admin the selection went stale.
	async function swapNow() {
		if (squadPlayerIds.length === 0) return
		const initialTeams = new Map(
			squadPlayerIds.map((id) => [id, TSWClient.Sel.localState(Zus.getState(stores.squadServer)).players.get(id)]),
		)
		const unsubscribe = Zus.resolveReadStore(stores.squadServer).subscribe((state) => {
			const current = TSWClient.Sel.localState(state)
			if (squadPlayerIds.some((id) => current.players.get(id) !== initialTeams.get(id))) closeDialog()
		})
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
				const msg = TSW_Msgs.swapNow(msgTarget).confirm()
				const result = await openDialog({
					title: msg.title,
					variant: 'destructive',
					description: msg.description,
					buttons: [{ id: 'confirm', label: msg.confirmLabel }],
				})
				if (result === 'dismissed') {
					toast.warning(...TSW_Msgs.swapCancelled(msgTarget).toast())
					return
				}
				if (result !== 'confirm') return
				TSWClient.Actions.swapNow(stores, squadPlayerIds)
			})
		} finally {
			unsubscribe()
		}
	}

	// open (or raise) the squad's details window and focus its warn box (which prefixes @Squad<id>)
	function warn() {
		if (uniqueId === null) return
		openOrFocusWindow(WINDOW_ID.enum['squad-details'], { uniqueSquadId: uniqueId, stores })
		WarnChat.requestWarnFocus({ kind: 'squad', uniqueSquadId: uniqueId })
	}

	async function warnSquadPreset() {
		presetReasonRef.current = ''
		const msg = SM_Msgs.warnPreset(msgTarget).confirm()
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
		const res = await warnPlayersMutation.mutateAsync({
			serverId,
			playerIds: squadPlayerIds,
			...input,
			taggedSquad: { squadId: squad.squadId, squadName: squad.squadName, teamId: squad.teamId },
		})
		if (res.code !== 'ok') {
			toast.error(...SM_Msgs.warnFailed('msg' in res ? res.msg : res.code).toast())
			return
		}
		toast(...SM_Msgs.warned(msgTarget, presetReasonRef.current).toast())
	}

	async function killSquad() {
		if (squadPlayerIds.length === 0) return
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const msg = SM_Msgs.kill(msgTarget).confirm()
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
			// awaited inside withPlayerDialogue so the presence dialogue stays open until the kill settles
			const res = await killMutation.mutateAsync({ serverId, playerIds: squadPlayerIds, ...input })
			if (res.code !== 'ok') {
				toast.error(...SM_Msgs.killFailed('msg' in res && res.msg ? res.msg : res.code).toast())
				return
			}
			toast(...SM_Msgs.kill(msgTarget).toast())
		})
	}

	async function kickSquad() {
		if (squadPlayerIds.length === 0) return
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const msg = SM_Msgs.kick(msgTarget).confirm()
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
			const res = await kickMutation.mutateAsync({ serverId, playerIds: squadPlayerIds, ...input })
			if (res.code !== 'ok') {
				toast.error(...SM_Msgs.kickFailed('msg' in res && res.msg ? res.msg : res.code).toast())
				return
			}
			toast(...SM_Msgs.kick(msgTarget).toast())
		})
	}

	async function timeoutSquad() {
		if (squadPlayerIds.length === 0) return
		timeoutDurationRef.current = ''
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const msg = SM_Msgs.timeout(msgTarget).confirm()
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
			const input = SquadServerClient.readReasonInput({
				action: 'timeout',
				required: timeoutReasonRequired,
				presetRef: presetReasonRef,
				customRef: customReasonRef,
			})
			if (!input) return
			await TimeoutsClient.timeoutPlayers(timeoutMutation.mutateAsync, {
				serverId,
				playerIds: squadPlayerIds,
				durationText: timeoutDurationRef.current,
				maxTimeout,
				...input,
			})
		})
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('DISBANDING_SQUAD', async () => {
			const msg = SM_Msgs.disbandSquad(squadLabel).confirm()
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				content: <ReasonPicker action="disband-squad" presetRef={presetReasonRef} required={disbandReasonRequired} />,
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
				teamId,
				squadId: squad.squadId,
				presetReasonLabel: input.presetReasonLabel,
			})
		})
	}

	async function resetSquadName() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('RESETTING_SQUAD_NAME', async () => {
			const msg = SM_Msgs.resetSquadName(`squad ${squadLabel}`).confirm()
			const result = await openDialog({
				title: msg.title,
				description: msg.description,
				buttons: [{ id: 'confirm', label: msg.confirmLabel }],
			})
			if (result !== 'confirm') return
			await resetSquadNameMutation.mutateAsync({ serverId, teamId, squadId: squad.squadId })
		})
	}

	return (
		<>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.swapNext(stores, squadPlayerIds)}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canQueue}
				>
					Swap Squad Next
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={swapNow}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canSwapNow}
				>
					Swap Squad Now
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={killSquad}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canSwapNow}
				>
					Kill Squad
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={kickDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kickSquad}
					disabled={!!kickDenied || squadPlayerIds.length === 0}
				>
					Kick Squad
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={timeoutDenied}>
				<Item
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={timeoutSquad}
					disabled={!!timeoutDenied || squadPlayerIds.length === 0}
				>
					Timeout Squad
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<Item
				disabled={squadPlayerIds.length === 0}
				onClick={() => {
					if (squadPlayerIds.length === 0) return
					TSWClient.Actions.ensureViewingTeams(serverId)
					SquadServerFrame.Actions.selectSquad(stores, squadPlayerIds[0])
				}}
			>
				<span title="Shortcut: shift+click the Squad cell in the teams panel">Select Squad</span>
				<ContextMenuShortcut>⇧+click squad cell</ContextMenuShortcut>
			</Item>
			{!omitWarn && (
				<>
					<Separator />
					<WarnReasonsSub
						slots={slots}
						denied={warnDenied}
						disabled={uniqueId === null || squadPlayerIds.length === 0}
						label="Warn Squad"
						onCustom={warn}
						onPreset={warnSquadPreset}
					/>
				</>
			)}
			<AddPlayerFlagsMenuItem slots={slots} playerIds={squadPlayerIds} target={msgTarget} label="Add Flags to Squad..." />
			<Separator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={disbandSquad} disabled={!!manageDenied || !squadExists}>
					Disband Squad
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item onClick={resetSquadName} disabled={!!manageDenied || !squadExists}>
					Reset Squad Name
				</Item>
			</PermissionDeniedTooltip>
		</>
	)
}

export default function SquadContextMenuOptions({
	squad,
	stores,
}: {
	squad: Pick<SM.Squad, 'squadId' | 'teamId' | 'squadName'>
	stores: SquadServerFrame.KeyProp
}) {
	return <SquadMenuItems squad={squad} slots={contextMenuSlots} stores={stores} />
}
