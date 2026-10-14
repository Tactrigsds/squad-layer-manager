import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Cross2Icon } from '@radix-ui/react-icons'
import * as React from 'react'

import * as Browser from '@/lib/browser'
import { keepOpenOnToastClick } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as KEYS from '@/models/keybinds.models'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as KBClient from '@/systems/keybinds.client'
import { tr } from '@/systems/messages.client'
import * as SubmitChordClient from '@/systems/submit-chord.client'

import { DraggableWindowOutlet } from './draggable-window'

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.DIALOG)
	return (
		<DialogPrimitive.Overlay ref={ref} className={cn('fixed inset-0 bg-black/60', className)} style={{ zIndex, ...style }} {...props} />
	)
})
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

// The dialog is a panel with a title bar, a padded body and a footer. Header and footer bleed to the panel edge
// through negative margins, so a call site that puts arbitrary children between them needs no wrapper. On a
// phone the panel fills the viewport and the body scrolls.
const DialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
		// the keybinding scope of a dialog with bindings of its own. A plain dialog opens one of type `dialog`
		kbScope?: KBClient.ScopeHandle<KEYS.Extending<'dialog'>>
	}
>(({ className, children, style, onInteractOutside, kbScope: kbScopeProp, ...props }, ref) => {
	const plainScope = KBClient.useScope('dialog', {})
	const kbScope = kbScopeProp ?? plainScope
	const phone = Browser.useIsSmallViewport()
	const outletKey = React.useId()
	const contentRef = React.useRef<HTMLDivElement | null>(null)

	const combinedRef = (node: HTMLDivElement | null) => {
		contentRef.current = node
		kbScope.ref(node)
		if (typeof ref === 'function') {
			ref(node)
		} else if (ref) {
			;(ref as React.MutableRefObject<HTMLDivElement | null>).current = node
		}
	}

	const zIndex = useZIndex(ZI_OFFSETS.DIALOG)
	const zIndexStyle = { zIndex, ...style }

	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				ref={combinedRef}
				data-phone={phone || undefined}
				className={cn(
					'fd-dlg fixed flex flex-col gap-2 p-2.5 w-full max-w-lg',
					!phone && 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[calc(100vh-32px)]',
					className,
					// after the caller's classes: a phone dialog fills the screen whatever width it asked for
					phone && 'inset-0 max-w-none rounded-none border-0 max-h-none overflow-y-auto',
				)}
				style={zIndexStyle}
				onInteractOutside={(e) => {
					onInteractOutside?.(e)
					keepOpenOnToastClick(e)
				}}
				{...props}
			>
				<KBClient.Context.Provider value={kbScope.id}>
					<BaseZIndexContext.Provider value={zIndex}>
						<DraggableWindowOutlet outletKey={outletKey} getElement={() => contentRef.current}>
							{children}
						</DraggableWindowOutlet>
						<DialogPrimitive.Close
							{...SubmitChordClient.closeAttrs}
							className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm absolute inset-e-1.5 top-1.5"
						>
							<Cross2Icon />
							<span className="sr-only">{tr.text(UI_Msgs.close())}</span>
						</DialogPrimitive.Close>
					</BaseZIndexContext.Provider>
				</KBClient.Context.Provider>
			</DialogPrimitive.Content>
		</DialogPortal>
	)
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('fd-dlg-h -mx-2.5 -mt-2.5 shrink-0 flex-wrap py-1 pe-8', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('fd-dlg-f -mx-2.5 -mb-2.5 shrink-0 mt-auto', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn('fd-cond font-bold text-base', className)} {...props} />)
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description ref={ref} className={cn('basis-full font-sans text-xs font-normal text-text-2', className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
}
