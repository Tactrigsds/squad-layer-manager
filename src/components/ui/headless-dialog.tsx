import { CloseButton, Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { Cross2Icon } from '@radix-ui/react-icons'
import * as React from 'react'

import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { DraggableWindowOutlet } from './draggable-window'

interface DialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	children: React.ReactNode
	unmount?: boolean
}

const HeadlessDialog = ({ open, onOpenChange, children, unmount }: DialogProps) => {
	return (
		<Dialog open={open} onClose={() => onOpenChange(false)} className="relative z-50" unmount={unmount}>
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
>(({ className, children, showCloseButton = true, ...props }, ref) => {
	const isMobile = useIsMobile()
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

	return (
		<>
			<DialogBackdrop
				className="fixed inset-0 z-50 bg-black/80 transition-opacity duration-200 ease-out data-closed:opacity-0"
				transition
			/>
			<div className="fixed inset-0 z-50 flex w-screen items-center justify-center p-4">
				<DialogPanel
					ref={combinedRef}
					data-mobile={isMobile}
					className={cn(
						'relative grid w-full gap-4 border bg-background p-6 shadow-lg',
						'transition-opacity duration-150 ease-out data-closed:opacity-0',
						'sm:rounded-lg',
						isMobile && 'fixed top-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none rounded-none border-0',
						className,
					)}
					transition
					{...props}
				>
					<DraggableWindowOutlet outletKey={outletKey} getElement={() => panelRef.current}>
						{children}
					</DraggableWindowOutlet>
					{showCloseButton && (
						<CloseButton className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-hover:bg-accent data-hover:text-muted-foreground">
							<Cross2Icon className="h-4 w-4" />
							<span className="sr-only">Close</span>
						</CloseButton>
					)}
				</DialogPanel>
			</div>
		</>
	)
})
HeadlessDialogContent.displayName = 'HeadlessDialogContent'

const HeadlessDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
)
HeadlessDialogHeader.displayName = 'HeadlessDialogHeader'

const HeadlessDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
)
HeadlessDialogFooter.displayName = 'HeadlessDialogFooter'

const HeadlessDialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogTitle>,
	React.ComponentPropsWithoutRef<typeof DialogTitle>
>(({ className, ...props }, ref) => (
	<DialogTitle ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
))
HeadlessDialogTitle.displayName = 'HeadlessDialogTitle'

const HeadlessDialogDescription = React.forwardRef<
	React.ElementRef<typeof Description>,
	React.ComponentPropsWithoutRef<typeof Description>
>(({ className, ...props }, ref) => <Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />)
HeadlessDialogDescription.displayName = 'HeadlessDialogDescription'

const HeadlessDialogClose = React.forwardRef<
	React.ElementRef<typeof CloseButton>,
	React.ComponentPropsWithoutRef<typeof CloseButton>
>(({ className, ...props }, ref) => <CloseButton ref={ref} className={className} {...props} />)
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
