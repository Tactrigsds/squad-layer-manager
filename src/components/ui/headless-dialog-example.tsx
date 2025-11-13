import { useState } from 'react'
import { HeadlessDialog, HeadlessDialogClose, HeadlessDialogContent, HeadlessDialogDescription, HeadlessDialogFooter, HeadlessDialogHeader, HeadlessDialogTitle } from './headless-dialog'

export function HeadlessDialogExample() {
	const [open, setOpen] = useState(false)

	return (
		<div className="p-8">
			<button
				onClick={() => setOpen(true)}
				className="rounded bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
			>
				Open Dialog
			</button>

			<HeadlessDialog open={open} onOpenChange={setOpen}>
				<HeadlessDialogContent>
					<HeadlessDialogHeader>
						<HeadlessDialogTitle>Delete Account</HeadlessDialogTitle>
						<HeadlessDialogDescription>
							This action cannot be undone. This will permanently delete your account and remove your data from our servers.
						</HeadlessDialogDescription>
					</HeadlessDialogHeader>

					<div className="py-4">
						<p className="text-sm text-muted-foreground">
							Are you absolutely sure you want to delete your account? All of your projects, settings, and data will be permanently removed.
						</p>
					</div>

					<HeadlessDialogFooter>
						<HeadlessDialogClose className="rounded border border-input bg-background px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground">
							Cancel
						</HeadlessDialogClose>
						<HeadlessDialogClose className="rounded bg-destructive px-3 py-2 text-sm text-destructive-foreground hover:bg-destructive/90">
							Delete Account
						</HeadlessDialogClose>
					</HeadlessDialogFooter>
				</HeadlessDialogContent>
			</HeadlessDialog>
		</div>
	)
}

export function SimpleHeadlessDialogExample() {
	const [open, setOpen] = useState(false)

	const handleConfirm = () => {
		console.log('Confirmed!')
		setOpen(false)
	}

	return (
		<div className="p-8">
			<button
				onClick={() => setOpen(true)}
				className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
			>
				Open Simple Dialog
			</button>

			<HeadlessDialog open={open} onOpenChange={setOpen}>
				<HeadlessDialogContent>
					<HeadlessDialogHeader>
						<HeadlessDialogTitle>Confirm Action</HeadlessDialogTitle>
						<HeadlessDialogDescription>
							Are you sure you want to proceed with this action?
						</HeadlessDialogDescription>
					</HeadlessDialogHeader>

					<HeadlessDialogFooter>
						<button
							onClick={() => setOpen(false)}
							className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
						>
							Cancel
						</button>
						<button
							onClick={handleConfirm}
							className="rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
						>
							Confirm
						</button>
					</HeadlessDialogFooter>
				</HeadlessDialogContent>
			</HeadlessDialog>
		</div>
	)
}
