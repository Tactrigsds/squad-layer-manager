import * as SM from '@/models/squad.models'
import * as TeamsSwitchesClient from '@/systems/teamswitches.client'
import { useToast } from '@/hooks/use-toast'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export default function PlayerBulkContextMenuOptions({ playerIds }: { playerIds: SM.PlayerId[] }) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	async function switchNow() {
		const initialState = TeamsSwitchesClient.Select.localState(TeamsSwitchesClient.Store.getState())
		const initialTeams = new Map(playerIds.map(id => [id, initialState.players.get(id)]))
		const unsubscribe = TeamsSwitchesClient.Store.subscribe(state => {
			const current = TeamsSwitchesClient.Select.localState(state)
			if (playerIds.some(id => current.players.get(id) !== initialTeams.get(id))) closeDialog()
		})
		const result = await openDialog({
			title: 'Switch Players Now',
			description: `Move ${playerIds.length} players to the opposite team immediately?`,
			buttons: [{ id: 'confirm', label: 'Switch Now' }],
		})
		unsubscribe()
		if (result === 'dismissed') {
			toast({ title: 'Switch cancelled', description: 'One or more players changed teams', variant: 'destructive' })
			return
		}
		if (result !== 'confirm') return
		TeamsSwitchesClient.Actions.switchNow(playerIds)
	}

	return (
		<>
			<ContextMenuLabel>{playerIds.length} players selected</ContextMenuLabel>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={switchNow}>Switch Now</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={() => TeamsSwitchesClient.Actions.switchNext(playerIds)}>
				Switch Next
			</ContextMenuItem>
			<ContextMenuItem onClick={() => TeamsSwitchesClient.Actions.removeSwitch(playerIds)}>
				Remove from Switch Queue
			</ContextMenuItem>
		</>
	)
}
