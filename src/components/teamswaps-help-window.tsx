import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as Icons from 'lucide-react'
import type { TeamswapsHelpWindowProps } from './teamswaps-help-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<TeamswapsHelpWindowProps, unknown>({
	type: WINDOW_ID.enum['teamswaps-help'],
	component: TeamswapsHelpWindow,
	initialPosition: 'left',
	getId: () => 'teamswaps-help',
})

function TeamswapsHelpWindow() {
	useDraggableWindow()
	return (
		<div className="min-w-0 min-h-0 flex flex-col w-80">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>Team Swaps Help</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="px-4 py-3 text-sm space-y-3 text-muted-foreground">
				<p>
					Queue players to be moved to the opposite team, either at the start of the next round or immediately.
				</p>
				<ol className="list-decimal list-inside space-y-2">
					<li>
						Right-click a player and choose <strong className="text-foreground">Swap Next</strong> to queue them.
					</li>
					<li>
						Click <strong className="text-foreground">Save</strong>{' '}
						to commit your queue. Players are notified in-game that they will be swapped at the start of the next round.
					</li>
					<li>
						Click <strong className="text-foreground">Swap Now</strong> to immediately execute all saved swaps.
					</li>
				</ol>
				<ul className="space-y-2">
					<li className="flex items-start gap-2">
						<Icons.Undo2 className="h-3.5 w-3.5 shrink-0 text-foreground mt-0.5" />
						<span>
							<strong className="text-foreground">Revert</strong> discards unsaved edits back to the last saved state.
						</span>
					</li>
					<li className="flex items-start gap-2">
						<Icons.Trash2 className="h-3.5 w-3.5 shrink-0 text-foreground mt-0.5" />
						<span>
							The <strong className="text-foreground">trash icon</strong> on a team column clears all for that team.
						</span>
					</li>
				</ul>
			</div>
		</div>
	)
}
