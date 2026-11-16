import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { BaseZIndexContext, ZI_OFFSETS } from '@/models/zindex.models'
import { tr } from '@/systems/messages.client'

// Covers the viewport while `fullscreen` is set. Its children stay mounted either way, so an editor inside keeps its
// buffer and history. Escape leaves fullscreen unless something inside handled the key first, such as an open popover
// or CodeMirror's autocomplete. A transformed ancestor would become the containing block of the `fixed` surface, so
// this must not be rendered inside one, such as a dialog.
export function FullscreenSurface(props: {
	fullscreen: boolean
	onExit: () => void
	className?: string
	style?: React.CSSProperties
	children: React.ReactNode
}) {
	const { fullscreen, onExit } = props
	const baseZIndex = React.useContext(BaseZIndexContext)
	const zIndex = fullscreen ? baseZIndex + ZI_OFFSETS.DIALOG : baseZIndex

	React.useEffect(() => {
		if (!fullscreen) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !e.defaultPrevented) onExit()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [fullscreen, onExit])

	return (
		<BaseZIndexContext.Provider value={zIndex}>
			<div
				className={cn(props.className, fullscreen && 'fixed inset-0 h-screen w-screen bg-background p-4')}
				style={fullscreen ? { zIndex } : props.style}
			>
				{props.children}
			</div>
		</BaseZIndexContext.Provider>
	)
}

export function FullscreenToggle(props: { fullscreen: boolean; onToggle: () => void; className?: string; style?: React.CSSProperties }) {
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					aria-label={tr.text(UI_Msgs.fullscreen())}
					aria-pressed={props.fullscreen}
					className={props.className}
					style={props.style}
					onClick={props.onToggle}
				>
					{props.fullscreen ? <Icons.Minimize2 /> : <Icons.Maximize2 />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{tr.text(props.fullscreen ? UI_Msgs.exitFullscreen() : UI_Msgs.fullscreen())}</TooltipContent>
		</Tooltip>
	)
}
