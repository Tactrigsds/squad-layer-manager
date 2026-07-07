import { AlertTriangle } from 'lucide-react'
import React, { useCallback, useContext } from 'react'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type AlertDialogButton = {
	id: string
	label: string
	variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
}

type AlertDialogOptions = {
	title: string
	description?: string
	content?: React.ReactNode
	buttons?: AlertDialogButton[]
	// 'destructive' accents the dialog (title color + icon, border) and defaults action buttons to the
	// destructive button variant, to match a destructive triggering action
	variant?: 'default' | 'destructive'
	onOpenChange?: (open: boolean) => void
	onOpen?: () => void
	onClose?: () => void
}

type AlertDialogContextType = {
	openDialog: (options: AlertDialogOptions) => Promise<string>
	closeDialog: () => void
}

const AlertDialogContext = React.createContext<AlertDialogContextType>({
	openDialog: () => Promise.reject('AlertDialogProvider not found'),
	closeDialog: () => {},
})

export function AlertDialogProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = React.useState(false)
	const [options, setOptions] = React.useState<AlertDialogOptions | null>(null)
	const resolveRef = React.useRef<((value: string) => void) | null>(null)

	const openDialog = useCallback((opts: AlertDialogOptions): Promise<string> => {
		return new Promise((resolve) => {
			// settle any dialog still awaiting a result before replacing it, so its caller's
			// finally-block runs (clearing presence activity, unsubscribing) instead of hanging forever
			resolveRef.current?.('dismissed')
			setOptions(opts)
			setOpen(true)
			resolveRef.current = resolve
			opts.onOpen?.()
		})
	}, [])

	const closeDialog = useCallback(() => {
		resolveRef.current?.('dismissed')
		resolveRef.current = null
		setOpen(false)
		setOptions(null)
	}, [])

	const handleOpenChange = (open: boolean) => {
		setOpen(open)
		options?.onOpenChange?.(open)
		if (!open) {
			options?.onClose?.()
			// resolve in case dialog was dismissed via Escape / overlay
			resolveRef.current?.('cancel')
			resolveRef.current = null
			setOptions(null)
		}
	}

	const handleButtonClick = (buttonId: string) => {
		resolveRef.current?.(buttonId)
		resolveRef.current = null
		setOpen(false)
	}

	const contextValue = React.useMemo(() => ({ openDialog, closeDialog }), [openDialog, closeDialog])

	const isDestructive = options?.variant === 'destructive'

	return (
		<AlertDialogContext.Provider value={contextValue}>
			{children}
			<AlertDialog open={open} onOpenChange={handleOpenChange}>
				<AlertDialogContent
					className={cn(isDestructive && 'border-destructive/50')}
					onOpenAutoFocus={e => {
						// only steal focus for content that has a text input; otherwise let the default (confirm button) win
						const input = options?.content ? (e.currentTarget as HTMLElement).querySelector('input') : null
						if (!input) return
						e.preventDefault()
						input.focus()
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle className={cn(isDestructive && 'flex items-center gap-2 text-destructive')}>
							{isDestructive && <AlertTriangle className="h-5 w-5 shrink-0" />}
							{options?.title}
						</AlertDialogTitle>
						{options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
					</AlertDialogHeader>
					{options?.content && (
						<form
							className="contents"
							onSubmit={e => {
								e.preventDefault()
								if (options.buttons?.[0]) handleButtonClick(options.buttons[0].id)
							}}
						>
							{options.content}
						</form>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => handleButtonClick('cancel')}>Cancel</AlertDialogCancel>
						{options?.buttons?.map((button) => {
							const variant = button.variant ?? (isDestructive ? 'destructive' : undefined)
							return (
								<AlertDialogAction
									key={button.id}
									className={variant ? buttonVariants({ variant }) : undefined}
									onClick={() => handleButtonClick(button.id)}
								>
									{button.label}
								</AlertDialogAction>
							)
						})}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</AlertDialogContext.Provider>
	)
}

export function useAlertDialog() {
	const context = useContext(AlertDialogContext)
	if (!context) {
		throw new Error('useAlertDialog must be used within AlertDialogProvider')
	}
	return context.openDialog
}

export function useCloseAlertDialog() {
	const context = useContext(AlertDialogContext)
	if (!context) {
		throw new Error('useCloseAlertDialog must be used within AlertDialogProvider')
	}
	return context.closeDialog
}
