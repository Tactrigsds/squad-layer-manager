import { CloseButton, Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { Cross2Icon } from '@radix-ui/react-icons'
import * as React from 'react'

import * as Browser from '@/lib/browser'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

import { DraggableWindowOutlet } from './draggable-window'

interface DialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	children: React.ReactNode
	unmount?: boolean
}

const HeadlessDialog = ({ open, onOpenChange, children, unmount }: DialogProps) => {
	return (
		<Dialog open={open} onClose={() => onOpenChange(false)} className="relative" unmount={unmount}>
			{children}
		</Dialog>
	)
}

const HeadlessDialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPanel>,
	Omit<React.ComponentPropsWithoutRef<typeof DialogPanel>, 'children'> & {
		showCloseButton?: boolean
		children?: React.ReactNode
	}
>(({ className, children, showCloseButton = true, style, ...props }, ref) => {
	const phone = Browser.useIsSmallViewport()
	const outletKey = React.useId()
	const panelRef = React.useRef<HTMLDivElement | null>(null)

	const combinedRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			panelRef.current = node
			if (typeof ref === 'function') {
				ref(node)
			} else if (ref) {
				;(ref as React.MutableRefObject<HTMLDivElement | null>).current = node
			}
		},
		[ref],
	)

	const zIndex = useZIndex(ZI_OFFSETS.DIALOG)

	return (
		<>
			<DialogBackdrop className="fixed inset-0 bg-black/60" style={{ zIndex }} />
			<div className={cn('fixed inset-0 flex w-screen items-center justify-center', !phone && 'p-4')} style={{ zIndex }}>
				<DialogPanel
					ref={combinedRef}
					data-phone={phone || undefined}
					className={cn(
						'fd-dlg relative flex w-full flex-col gap-2 p-2.5',
						phone && 'h-full max-w-none max-h-none rounded-none border-0',
						className,
					)}
					style={style}
					{...props}
				>
					<BaseZIndexContext.Provider value={zIndex}>
						<DraggableWindowOutlet outletKey={outletKey} getElement={() => panelRef.current}>
							{children}
						</DraggableWindowOutlet>
					</BaseZIndexContext.Provider>
					{showCloseButton && (
						<CloseButton className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm absolute right-1.5 top-1.5">
							<Cross2Icon />
							<span className="sr-only">{tr.text(UI_Msgs.close())}</span>
						</CloseButton>
					)}
				</DialogPanel>
			</div>
		</>
	)
})
HeadlessDialogContent.displayName = 'HeadlessDialogContent'

const HeadlessDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('fd-dlg-h -mx-2.5 -mt-2.5 shrink-0 flex-wrap py-1 pr-8', className)} {...props} />
)
HeadlessDialogHeader.displayName = 'HeadlessDialogHeader'

const HeadlessDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('fd-dlg-f -mx-2.5 -mb-2.5 shrink-0', className)} {...props} />
)
HeadlessDialogFooter.displayName = 'HeadlessDialogFooter'

const HeadlessDialogTitle = React.forwardRef<React.ElementRef<typeof DialogTitle>, React.ComponentPropsWithoutRef<typeof DialogTitle>>(
	({ className, ...props }, ref) => <DialogTitle ref={ref} className={cn('fd-cond font-bold text-base', className)} {...props} />,
)
HeadlessDialogTitle.displayName = 'HeadlessDialogTitle'

const HeadlessDialogDescription = React.forwardRef<
	React.ElementRef<typeof Description>,
	React.ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => (
	<Description ref={ref} className={cn('font-sans text-xs font-normal text-text-2', className)} {...props} />
))
HeadlessDialogDescription.displayName = 'HeadlessDialogDescription'

const HeadlessDialogClose = React.forwardRef<React.ElementRef<typeof CloseButton>, React.ComponentPropsWithoutRef<typeof CloseButton>>(
	({ className, ...props }, ref) => <CloseButton ref={ref} className={className} {...props} />,
)
HeadlessDialogClose.displayName = 'HeadlessDialogClose'

export {
	HeadlessDialog,
	HeadlessDialogClose,
	HeadlessDialogContent,
	HeadlessDialogDescription,
	HeadlessDialogFooter,
	HeadlessDialogHeader,
	HeadlessDialogTitle,
}
