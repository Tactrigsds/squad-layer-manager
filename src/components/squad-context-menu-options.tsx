import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ZusUtils from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as WarnChat from '@/systems/warn-chat.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu'
import { useAlertDialog } from './ui/lazy-alert-dialog'

const contextMenuSlots: MenuSlots = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
}

export function SquadMenuItems(
	{ squad, slots, stores, omitWarn }: {
		squad: Pick<SM.Squad, 'squadId' | 'teamId' | 'squadName'>
		slots: MenuSlots
		stores: SquadServerFrame.KeyProp
		// hidden inside the squad details window, which has its own warn box at the bottom
		omitWarn?: boolean
	},
) {
	const { Item, Separator } = slots
	const openDialog = useAlertDialog()
	const openOrFocusWindow = useOpenOrFocusWindow()

	const disbandSquadMutation = SquadServerClient.useDisbandSquadMutation()
	const resetSquadNameMutation = SquadServerClient.useResetSquadNameMutation()

	// uniqueId isn't on the passed-in squad prop, so resolve it (and live membership) from chat state; it's
	// null when the squad isn't currently live, in which case there's nothing to warn
	const { squadPlayerIds, squadExists, uniqueId } = ZusUtils.useStore(
		stores.squadServer,
		(chatStore: ChatPrt.Store) => {
			const state = ChatPrt.Sel.chatState(chatStore)
			const liveSquad = state.squads.find(s => s.squadId === squad.squadId && s.teamId === squad.teamId)
			const squadPlayerIds = state.players
				.filter(p => p.squadId === squad.squadId && p.teamId === squad.teamId)
				.map(p => SM.PlayerIds.getPlayerId(p.ids))
			return { squadPlayerIds, squadExists: !!liveSquad, uniqueId: liveSquad?.uniqueId ?? null }
		},
	)

	const canSwitchNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwitchNow(squadPlayerIds))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canQueue(squadPlayerIds))
	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))

	const squadLabel = `"${squad.squadName}"`
	const teamId = squad.teamId as 1 | 2
	const serverId = stores.squadServer.serverId

	// open (or raise) the squad's details window and focus its warn box (which prefixes @Squad<id>)
	function warn() {
		if (uniqueId === null) return
		openOrFocusWindow(WINDOW_ID.enum['squad-details'], { uniqueSquadId: uniqueId, stores })
		WarnChat.requestWarnFocus({ kind: 'squad', uniqueSquadId: uniqueId })
	}

	async function disbandSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		const result = await openDialog({
			title: 'Disband Squad',
			description: `Disband squad ${squadLabel}?`,
			buttons: [{ id: 'confirm', label: 'Disband' }],
		})
		if (result !== 'confirm') return
		await disbandSquadMutation.mutateAsync({ serverId, teamId, squadId: squad.squadId })
	}

	async function resetSquadName() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		const result = await openDialog({
			title: 'Reset Squad Name',
			description: `Reset the name of squad ${squadLabel} to default?`,
			buttons: [{ id: 'confirm', label: 'Reset' }],
		})
		if (result !== 'confirm') return
		await resetSquadNameMutation.mutateAsync({ serverId, teamId, squadId: squad.squadId })
	}

	return (
		<>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.switchNext(stores, squadPlayerIds)}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canQueue}
				>
					Switch Squad Next
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.switchNow(stores, squadPlayerIds)}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canSwitchNow}
				>
					Switch Squad Now
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<Item
				disabled={squadPlayerIds.length === 0}
				onClick={() => {
					if (squadPlayerIds.length === 0) return
					TSWClient.Actions.ensureViewingTeams(serverId)
					const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer)).players
					SquadServerClient.Actions.selectSquad(squadPlayerIds[0], players)
				}}
			>
				<span title="Shortcut: shift+click the Squad cell in the teams panel">Select Squad</span>
				<ContextMenuShortcut>⇧+click squad cell</ContextMenuShortcut>
			</Item>
			{!omitWarn && (
				<>
					<Separator />
					<PermissionDeniedTooltip denied={warnDenied}>
						<Item onClick={warn} disabled={!!warnDenied || uniqueId === null || squadPlayerIds.length === 0}>
							Warn Squad
						</Item>
					</PermissionDeniedTooltip>
				</>
			)}
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

export default function SquadContextMenuOptions(
	{ squad, stores }: { squad: Pick<SM.Squad, 'squadId' | 'teamId' | 'squadName'>; stores: SquadServerFrame.KeyProp },
) {
	return <SquadMenuItems squad={squad} slots={contextMenuSlots} stores={stores} />
}
