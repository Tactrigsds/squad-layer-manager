import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { PlayerDetailsWindowProps } from './player-details-window.helpers'

DraggableWindowStore.getState().registerDefinition<PlayerDetailsWindowProps>({
	type: WINDOW_ID.enum['player-details'],
	component: PlayerDetailsWindow,
	initialPosition: 'left',
	getId: (props) => props.playerId,
})

function PlayerDetailsWindow({ playerId }: PlayerDetailsWindowProps) {
	return (
		<div>
			<h2>
				player details
			</h2>
			<span>{playerId}</span>
		</div>
	)
}
