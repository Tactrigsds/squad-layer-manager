import * as Icons from 'lucide-react'

import * as TSW_Msgs from '@/messages/teamswaps.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

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
				<DraggableWindowTitle>{tr.text(TSW_Msgs.helpTitle())}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="px-4 py-3 text-sm space-y-3 text-muted-foreground [&_strong]:text-foreground">
				<p>{tr.text(TSW_Msgs.helpIntro())}</p>
				<ol className="list-decimal list-inside space-y-2">
					<li>{tr.richText(TSW_Msgs.helpStepQueue())}</li>
					<li>{tr.richText(TSW_Msgs.helpStepSave())}</li>
					<li>{tr.richText(TSW_Msgs.helpStepSwapNow())}</li>
				</ol>
				<ul className="space-y-2">
					<li className="flex items-start gap-2">
						<Icons.Undo2 className="h-3.5 w-3.5 shrink-0 text-foreground mt-0.5" />
						<span>{tr.richText(TSW_Msgs.helpRevert())}</span>
					</li>
					<li className="flex items-start gap-2">
						<Icons.Trash2 className="h-3.5 w-3.5 shrink-0 text-foreground mt-0.5" />
						<span>{tr.richText(TSW_Msgs.helpClearTeam())}</span>
					</li>
				</ul>
			</div>
		</div>
	)
}
