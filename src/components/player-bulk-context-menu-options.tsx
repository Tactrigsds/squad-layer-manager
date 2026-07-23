import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import type * as AAR from '@/models/admin-action-reasons.models'
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
import React from 'react'
import { AddPlayerFlagsMenuItem } from './bm-flag-workflows'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { contextMenuSlots, PlayerCopyIdsSub, PlayerOpenLinksSub, TimeoutDialogContent } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'
import { ReasonPicker, WarnReasonsSub } from './warn-reasons-sub'

// When the selection is exactly one squad's full membership (and nothing else), returns that squad so the
// warn action can route to the squad details window; otherwise null (mixed/partial selection).
function detectFullSquadSelection(
	selectedIds: SM.PlayerId[],
	players: SM.Player[],
	squads: SM.UniqueSquad[],
): SM.UniqueSquad | null {
	if (selectedIds.length === 0) return null
	const first = SM.PlayerIds.find(players, p => p.ids, selectedIds[0])
	if (!first || first.squadId === null || first.teamId === null) return null
	const { squadId, teamId } = first
	for (const id of selectedIds) {
		const p = SM.PlayerIds.find(players, p => p.ids, id)
		if (!p || p.squadId !== squadId || p.teamId !== teamId) return null
	}
	const memberCount = players.filter(p => p.squadId === squadId && p.teamId === teamId).length
	if (memberCount !== selectedIds.length) return null
	return squads.find(s => s.squadId === squadId && s.teamId === teamId) ?? null
}

export default function PlayerBulkContextMenuOptions(
	{ playerIds, stores }: { playerIds: SM.PlayerId[]; stores: SquadServerFrame.KeyProp },
) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()

	const removePlayersFromSquadMutation = SquadServerClient.useRemovePlayersFromSquadMutation()
	const killMutation = SquadServerClient.useKillMutation()
	const kickMutation = SquadServerClient.useKickPlayersMutation()
	const timeoutMutation = TimeoutsClient.useTimeoutPlayerMutation()
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const maxTimeout = TimeoutsClient.useMaxTimeout()
	const killReasonRequired = SettingsClient.useReasonRequired('kill')
	const kickReasonRequired = SettingsClient.useReasonRequired('kick')
	const timeoutReasonRequired = SettingsClient.useReasonRequired('timeout')
	const removeReasonRequired = SettingsClient.useReasonRequired('remove-from-squad')
	const serverId = stores.squadServer.serverId
	const openOrFocusWindow = useOpenOrFocusWindow()
	// holds the latest custom-reason input value; the alert dialog only resolves a button id, so we read the
	// reason from here rather than the (unmounting) DOM input when the dialog confirms
	const customReasonRef = React.useRef('')
	// same mechanism for the preset-reason pick in the action confirmation dialogs; reset on each dialog open
	const presetReasonRef = React.useRef('')
	const timeoutDurationRef = React.useRef('')

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const kickDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:kick-players'))
	const timeoutDenied = RbacClient.usePermsCheck('squad-server:timeout-players')
	const canSwapNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwapNow(playerIds))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.someCanQueue(playerIds))

	// when the selection is exactly one full squad, the warn action targets the squad details window and the
	// menu item reads "Warn Squad"; otherwise it routes to the server activity "selected" warn box
	const fullSquad = ZusUtils.useStore(
		stores.squadServer,
		(chatStore: ChatPrt.Store) => {
			const state = ChatPrt.Sel.chatState(chatStore)
			return detectFullSquadSelection(playerIds, state.players, state.squads)
		},
	)

	// scrollable list of the selected players' usernames, shown in the swap/kill confirmation dialogs so
	// the admin can see exactly who is affected
	function selectedPlayerList() {
		// recent rather than live, so a player who dropped since being selected is still named rather than
		// rendering as a bare id
		const players = ChatPrt.Sel.recentPlayers(ZusUtils.getState(stores.squadServer))
		return (
			<ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border bg-muted/30 p-2 text-sm">
				{playerIds.map(id => {
					const p = SM.PlayerIds.find(players, p => p.ids, id)
					return <li key={id} className="truncate">{p?.ids.usernameNoTag ?? p?.ids.username ?? id}</li>
				})}
			</ul>
		)
	}

	async function swapNow() {
		const initialState = TSWClient.Sel.localState(ZusUtils.getState(stores.squadServer))
		const initialTeams = new Map(playerIds.map(id => [id, initialState.players.get(id)]))
		const unsubscribe = ZusUtils.resolveReadStore(stores.squadServer).subscribe(state => {
			const current = TSWClient.Sel.localState(state)
			if (playerIds.some(id => current.players.get(id) !== initialTeams.get(id))) closeDialog()
		})
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
				const result = await openDialog({
					title: 'Swap Players Now',
					variant: 'destructive',
					description: `Move these ${playerIds.length} players to the opposite team immediately?`,
					content: selectedPlayerList(),
					buttons: [{ id: 'confirm', label: 'Swap Now' }],
				})
				if (result === 'dismissed') {
					toast.warning('Swap cancelled', { description: 'One or more players changed teams' })
					return
				}
				if (result !== 'confirm') return
				TSWClient.Actions.swapNow(stores, playerIds)
			})
		} finally {
			unsubscribe()
		}
	}

	async function kill() {
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Kill Players',
				variant: 'destructive',
				description:
					`Kill these ${playerIds.length} players? They will be force-switched teams twice in quick succession to trigger a respawn, ending back on their current team.`,
				content: (
					<div className="grid gap-3 py-2">
						{selectedPlayerList()}
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
			// awaited inside withPlayerDialogue so the presence dialogue stays open until the kill settles
			const res = await killMutation.mutateAsync({ serverId, playerIds, ...input })
			if (res.code !== 'ok') {
				toast.error('Kill failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
				return
			}
			toast(`Killed ${playerIds.length} players`)
		})
	}

	async function kick() {
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Kick Players',
				variant: 'destructive',
				description: `Kick these ${playerIds.length} players from the server? They may rejoin immediately.`,
				content: (
					<div className="grid gap-3 py-2">
						{selectedPlayerList()}
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
			const res = await kickMutation.mutateAsync({ serverId, playerIds, ...input })
			if (res.code !== 'ok') {
				toast.error('Kick failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
				return
			}
			toast(`Kicked ${playerIds.length} players`)
		})
	}

	async function timeout() {
		timeoutDurationRef.current = ''
		customReasonRef.current = ''
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
			const result = await openDialog({
				title: 'Timeout Players',
				variant: 'destructive',
				description:
					`Kick these ${playerIds.length} players? They will be re-kicked on join from any SLM-managed server until the timeout expires.`,
				content: (
					<div className="grid gap-3 py-2">
						{selectedPlayerList()}
						<TimeoutDialogContent
							durationRef={timeoutDurationRef}
							customReasonRef={customReasonRef}
							presetReasonRef={presetReasonRef}
							maxTimeout={maxTimeout}
							required={timeoutReasonRequired}
						/>
					</div>
				),
				buttons: [{ id: 'confirm', label: 'Timeout' }],
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
				playerIds,
				durationText: timeoutDurationRef.current,
				maxTimeout,
				...input,
			})
		})
	}

	// a full-squad selection warns via the squad details window (prefixed @Squad); anything else routes to the
	// server activity "selected" warn box, which warns exactly the current selection
	function warn() {
		if (fullSquad) {
			openOrFocusWindow(WINDOW_ID.enum['squad-details'], { uniqueSquadId: fullSquad.uniqueId, stores })
			WarnChat.requestWarnFocus({ kind: 'squad', uniqueSquadId: fullSquad.uniqueId })
		} else {
			WarnChat.requestWarnFocus({ kind: 'server-activity' })
		}
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		presetReasonRef.current = ''
		await UPClient.Actions.withPlayerDialogue('REMOVING_FROM_SQUAD', async () => {
			const result = await openDialog({
				title: 'Remove from Squad',
				description: `Remove ${playerIds.length} players from their squads?`,
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
			// one call for the whole batch: the server aggregates the resulting squad-leaves under a single app event
			// unwrap() keeps the presence dialogue open until it settles; the toast surfaces any error
			await toast.promise(
				removePlayersFromSquadMutation.mutateAsync({ serverId, playerIds, presetReasonLabel: input.presetReasonLabel }),
				{
					loading: `Removing ${playerIds.length} players from their squads...`,
					success: `Removed ${playerIds.length} players from their squads`,
					error: { message: 'Remove from squad failed', description: `Failed to remove ${playerIds.length} players`, richColors: true },
				},
			).unwrap().catch(() => {})
		})
	}

	// preset warns for a multi-selection get a confirmation dialog (bulk-action rule) instead of sending immediately
	async function warnPreset(reason: AAR.AdminActionReason) {
		const result = await openDialog({
			title: fullSquad ? 'Warn Squad' : 'Warn Players',
			description: `Warn these ${playerIds.length} players for ${reason.label}?`,
			content: selectedPlayerList(),
			buttons: [{ id: 'confirm', label: 'Warn' }],
		})
		if (result !== 'confirm') return
		const res = await warnPlayersMutation.mutateAsync({
			serverId,
			playerIds,
			presetReasonLabel: reason.label,
			taggedSquad: fullSquad ? { squadId: fullSquad.squadId, squadName: fullSquad.squadName, teamId: fullSquad.teamId } : undefined,
		})
		if (res.code !== 'ok') {
			toast.error('Warn failed', { description: 'msg' in res ? res.msg : res.code })
			return
		}
		toast(`Warned ${playerIds.length} players for ${reason.label}`)
	}

	return (
		<>
			<ContextMenuLabel>{playerIds.length} players selected</ContextMenuLabel>
			<ContextMenuItem onClick={() => SquadServerFrame.Actions.invertSelection(stores)}>
				Invert Selection
				<ContextMenuShortcut>Alt+Ctrl+click select-all box</ContextMenuShortcut>
			</ContextMenuItem>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.swapNext(stores, playerIds)} disabled={!!manageDenied || !canQueue}>
					Swap Next
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={swapNow}
					disabled={!!manageDenied || !canSwapNow}
				>
					Swap Now
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kill}
					disabled={!!manageDenied || !canSwapNow}
				>
					Kill
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={kickDenied}>
				<ContextMenuItem
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={kick}
					disabled={!!kickDenied || playerIds.length === 0}
				>
					Kick
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={timeoutDenied}>
				<ContextMenuItem
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={timeout}
					disabled={!!timeoutDenied || playerIds.length === 0}
				>
					Timeout
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.removeSwap(stores, playerIds)} disabled={!!manageDenied}>
					Delete Swaps
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<ContextMenuSeparator />
			<PlayerOpenLinksSub playerIds={playerIds} slots={contextMenuSlots} stores={stores} />
			<PlayerCopyIdsSub playerIds={playerIds} slots={contextMenuSlots} stores={stores} />
			<ContextMenuSeparator />
			<WarnReasonsSub
				slots={contextMenuSlots}
				denied={warnDenied}
				label={fullSquad ? 'Warn Squad' : 'Warn'}
				onCustom={warn}
				onPreset={warnPreset}
			/>
			<AddPlayerFlagsMenuItem
				slots={contextMenuSlots}
				playerIds={playerIds}
				targetDescription={fullSquad ? `squad "${fullSquad.squadName}"` : `these ${playerIds.length} players`}
			/>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={removeFromSquad} disabled={!!manageDenied}>Remove from Squad</ContextMenuItem>
			</PermissionDeniedTooltip>
		</>
	)
}
