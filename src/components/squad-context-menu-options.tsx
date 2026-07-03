import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ZusUtils from '@/lib/zustand'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { useAlertDialog } from './ui/lazy-alert-dialog'

const contextMenuSlots: MenuSlots = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

export function SquadMenuItems(
	{ squad, slots, stores }: {
		squad: Pick<SM.Squad, 'squadId' | 'teamId' | 'squadName'>
		slots: MenuSlots
		stores: SquadServerFrame.KeyProp
	},
) {
	const { Item, Separator } = slots
	const openDialog = useAlertDialog()

	const disbandSquadMutation = SquadServerClient.useDisbandSquadMutation()
	const resetSquadNameMutation = SquadServerClient.useResetSquadNameMutation()

	const { squadPlayerIds, squadExists } = ZusUtils.useStore(
		stores.squadServer,
		(chatStore: ChatPrt.Store) => {
			const state = ChatPrt.Sel.chatState(chatStore)
			const squadExists = state.squads.some(s => s.squadId === squad.squadId && s.teamId === squad.teamId)
			const squadPlayerIds = state.players
				.filter(p => p.squadId === squad.squadId && p.teamId === squad.teamId)
				.map(p => SM.PlayerIds.getPlayerId(p.ids))
			return { squadPlayerIds, squadExists }
		},
	)

	const canSwitchNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwitchNow(squadPlayerIds))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canQueue(squadPlayerIds))
	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))

	const squadLabel = `"${squad.squadName}"`
	const teamId = squad.teamId as 1 | 2
	const serverId = stores.squadServer.serverId

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
					onClick={() => TSWClient.Actions.switchNow(stores, squadPlayerIds)}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canSwitchNow}
				>
					Switch Squad Now
				</Item>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<Item
					onClick={() => TSWClient.Actions.switchNext(stores, squadPlayerIds)}
					disabled={!!manageDenied || squadPlayerIds.length === 0 || !canQueue}
				>
					Switch Squad Next
				</Item>
			</PermissionDeniedTooltip>
			{squadPlayerIds.length > 0 && (
				<>
					<Separator />
					<Item
						onClick={() => {
							TSWClient.Actions.ensureViewingTeams(serverId)
							const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer)).players
							SquadServerClient.Actions.selectSquad(squadPlayerIds[0], players)
						}}
					>
						Select Squad
					</Item>
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
