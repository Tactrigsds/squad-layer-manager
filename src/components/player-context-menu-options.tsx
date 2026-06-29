import * as ZusUtils from '@/lib/zustand'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import { useToast } from '@/hooks/use-toast'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export default function PlayerContextMenuOptions({ playerId }: { playerId: SM.PlayerId }) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const otherTeam = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		(chatStore: SquadServer.ChatStore, currentMatch: MH.MatchDetails | undefined): MH.NormedTeamId | null => {
			if (!currentMatch) return null
			const player = SM.PlayerIds.find(SquadServer.Select.chatState(chatStore).players, p => p.ids, playerId)
			if (!player?.teamId) return null
			const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
			return normed === 'A' ? 'B' : 'A'
		},
	)

	const existingSwitch = ZusUtils.useStore(
		TSWClient.Store,
		s => TSWClient.Select.localState(s).switches.get(playerId) ?? null,
	)

	const canSwitchNow = ZusUtils.useStore(TSWClient.Store, TSWClient.Select.canSwitchNow([playerId]))
	const canQueue = ZusUtils.useStore(TSWClient.Store, TSWClient.Select.canQueue([playerId]))

	async function switchNow() {
		if (!otherTeam) return
		const initialTeam = TSWClient.Select.localState(TSWClient.Store.getState()).players.get(playerId)
		const unsubscribe = TSWClient.Store.subscribe(state => {
			if (TSWClient.Select.localState(state).players.get(playerId) !== initialTeam) closeDialog()
		})
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
			TSWClient.Actions.switchNow([playerId])
		} finally {
			unsubscribe()
		}
	}

	return (
		<>
			<ContextMenuItem onClick={switchNow} disabled={!otherTeam || !canSwitchNow}>
				Switch Now
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				onClick={() => TSWClient.Actions.switchNext([playerId])}
				disabled={!otherTeam || !canQueue}
			>
				Switch Next
			</ContextMenuItem>
			{existingSwitch && (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() => TSWClient.Actions.removeSwitch([playerId])}
						disabled={!canSwitchNow}
					>
						Remove from Switch Queue
					</ContextMenuItem>
				</>
			)}
		</>
	)
}
