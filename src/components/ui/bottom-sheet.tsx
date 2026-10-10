import { X } from 'lucide-react'
import React from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import { tr } from '@/systems/messages.client'

// A panel along the bottom of a phone screen over a scrim. It is not modal: it leaves focus management to whatever
// dialog it opens from, which is what lets it open from inside the headless dialogs.
export function BottomSheetFrame(
	props: {
		title: React.ReactNode
		onClose: () => void
		// a tap on the scrim closes the sheet; a caller that dismisses on outside pointerdowns already turns it off
		closeOnScrim?: boolean
		children: React.ReactNode
		className?: string
	} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children'>,
) {
	const { title, onClose, closeOnScrim = true, children, className, ...rest } = props
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	const [node, setNode] = React.useState<HTMLDivElement | null>(null)

	// see PopoverContent: a Radix dialog's scroll lock swallows wheel events from portalled content
	React.useEffect(() => {
		if (!node) return
		const stopPropagation = (e: WheelEvent) => e.stopPropagation()
		node.addEventListener('wheel', stopPropagation)
		return () => node.removeEventListener('wheel', stopPropagation)
	}, [node])

	return (
		<>
			<div aria-hidden className="fixed inset-0 bg-black/60" style={{ zIndex }} onClick={closeOnScrim ? onClose : undefined} />
			<div
				ref={setNode}
				role="dialog"
				aria-label={typeof title === 'string' ? title : undefined}
				className={cn(
					'fd-dlg fixed inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden rounded-b-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] outline-none',
					className,
				)}
				style={{ zIndex }}
				{...rest}
			>
				<div className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-line-soft" />
				<div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line ps-3 pe-1">
					<span className="fd-cond min-w-0 flex-1 truncate text-base font-bold">{title}</span>
					<Button variant="ghost" size="icon" onClick={onClose} aria-label={tr.text(UI_Msgs.close())}>
						<X />
					</Button>
				</div>
				<BaseZIndexContext.Provider value={zIndex}>
					<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				</BaseZIndexContext.Provider>
			</div>
		</>
	)
}

export function BottomSheet(props: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode }) {
	const { open, onClose } = props
	// captured on the document so Escape closes the sheet and not the dialog beneath it
	React.useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.stopPropagation()
			onClose()
		}
		document.addEventListener('keydown', onKeyDown, { capture: true })
		return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
	}, [open, onClose])

	if (!open) return null
	return createPortal(
		<BottomSheetFrame title={props.title} onClose={onClose}>
			{props.children}
		</BottomSheetFrame>,
		document.body,
	)
}
