import React, { useCallback, useContext } from 'react'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

type AlertDialogButton = {
	id: string
	label: string
	variant?: 'default' | 'destructive' | 'outline-solid' | 'secondary' | 'ghost' | 'link'
}

type AlertDialogOptions = {
	title: string
	description?: string
	content?: React.ReactNode
	buttons?: AlertDialogButton[]
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

	return (
		<AlertDialogContext.Provider value={{ openDialog, closeDialog }}>
			{children}
			<AlertDialog open={open} onOpenChange={handleOpenChange}>
				<AlertDialogContent onOpenAutoFocus={e => {
						if (!options?.content) return
						e.preventDefault()
						;(e.currentTarget as HTMLElement).querySelector('input')?.focus()
					}}>
					<AlertDialogHeader>
						<AlertDialogTitle>{options?.title}</AlertDialogTitle>
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
						{options?.buttons?.map((button) => (
							<AlertDialogAction key={button.id} onClick={() => handleButtonClick(button.id)}>
								{button.label}
							</AlertDialogAction>
						))}
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
