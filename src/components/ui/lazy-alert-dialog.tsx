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
	buttons?: AlertDialogButton[]
	onOpenChange?: (open: boolean) => void
	onOpen?: () => void
	onClose?: () => void
}

type AlertDialogContextType = {
	openDialog: (options: AlertDialogOptions) => Promise<string>
}

const AlertDialogContext = React.createContext<AlertDialogContextType>({
	openDialog: () => Promise.reject('AlertDialogProvider not found'),
})

export function AlertDialogProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = React.useState(false)
	const [options, setOptions] = React.useState<AlertDialogOptions | null>(null)
	const [resolveRef, setResolveRef] = React.useState<((value: string) => void) | null>(null)

	const showDialog = useCallback((options: AlertDialogOptions): Promise<string> => {
		return new Promise((resolve) => {
			setOptions(options)
			setOpen(true)
			setResolveRef(() => resolve)
			options.onOpen?.()
		})
	}, [])

	const handleOpenChange = (open: boolean) => {
		setOpen(open)
		options?.onOpenChange?.(open)
		if (!open) {
			options?.onClose?.()
			setOptions(null)
		}
	}

	const handleButtonClick = (buttonId: string) => {
		setOpen(false)
		resolveRef?.(buttonId)
		setResolveRef(null)
	}

	return (
		<AlertDialogContext.Provider value={{ openDialog: showDialog }}>
			{children}
			<AlertDialog open={open} onOpenChange={handleOpenChange}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{options?.title}</AlertDialogTitle>
						{options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
					</AlertDialogHeader>
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
