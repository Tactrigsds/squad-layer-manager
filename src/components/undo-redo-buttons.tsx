import * as Icons from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as UI_Msgs from '@/messages/ui.messages'
import * as KEYS from '@/models/keybinds.models'
import * as KBClient from '@/systems/keybinds.client'
import { tr } from '@/systems/messages.client'

export type UndoButtonState = {
	// what the button would undo or redo, or null when there is nothing to
	description: string | null
	onClick: () => void
}

// The undo and redo buttons of one editor. They answer the undo and redo keys pressed in the editor's keybinding scope,
// which clicks them.
export function UndoRedoButtons(props: {
	undo: UndoButtonState
	redo: UndoButtonState
	size?: 'icon-sm' | 'icon'
	disabled?: boolean
	className?: string
}) {
	return (
		<>
			<UndoButton direction="undo" state={props.undo} size={props.size} disabled={props.disabled} className={props.className} />
			<UndoButton direction="redo" state={props.redo} size={props.size} disabled={props.disabled} className={props.className} />
		</>
	)
}

function UndoButton(props: {
	direction: 'undo' | 'redo'
	state: UndoButtonState
	size?: 'icon-sm' | 'icon'
	disabled?: boolean
	className?: string
}) {
	const label = tr.text(props.direction === 'undo' ? UI_Msgs.undo() : UI_Msgs.redo())
	const Icon = props.direction === 'undo' ? Icons.Undo2 : Icons.Redo2
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<Button
					{...KBClient.buttonAttrs(props.direction)}
					aria-label={label}
					size={props.size ?? 'icon-sm'}
					variant="ghost"
					className={props.className}
					disabled={props.disabled || props.state.description === null}
					onClick={props.state.onClick}
				>
					<Icon className="rtl:-scale-x-100" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p className="flex items-center gap-2">
					<span>{props.state.description ?? label}</span>
					<Kbd>{KEYS.label(props.direction)}</Kbd>
				</p>
			</TooltipContent>
		</Tooltip>
	)
}
