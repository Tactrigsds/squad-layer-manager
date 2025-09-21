import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { globalToast$ } from '@/hooks/use-global-toast'
import { cn } from '@/lib/utils'
import { trpc } from '@/trpc.client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

interface LinkSteamAccountDialogProps {
	children: React.ReactNode
	open?: boolean
	onOpenChange?: (newState: boolean) => void
}

export default function LinkSteamAccountDialog({ children, open, onOpenChange }: LinkSteamAccountDialogProps) {
	const queryClient = useQueryClient()
	const [command, setCommand] = React.useState<string | null>(null)
	const [copyStatus, setCopyStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle')

	const beginLinkMutation = useMutation({
		mutationFn: () => trpc.users.beginSteamAccountLink.mutate(),
		onSuccess: (result) => {
			if (result.code === 'ok') {
				setCommand(result.command)
				// Automatically copy to clipboard
				copyToClipboard(result.command)
			}
		},
		onError: (error) => {
			console.error('Failed to begin steam account link:', error)
		},
	})

	const cancelLinkMutation = useMutation({
		mutationFn: () => trpc.users.cancelSteamAccountLinks.mutate(),
		onSuccess: (result) => {
			setCommand(null)
			setCopyStatus('idle')
			queryClient.invalidateQueries({ queryKey: ['getLoggedInUser'] })
			if (result.code === 'ok') {
				globalToast$.next({
					title: 'Steam account linking cancelled',
					variant: 'default',
				})
			}
		},
		onError: (error) => {
			console.error('Failed to cancel steam account links:', error)
		},
	})

	const copyToClipboard = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopyStatus('copied')
			// Reset status after 2 seconds
			setTimeout(() => setCopyStatus('idle'), 2000)
		} catch (err) {
			console.error('Failed to copy to clipboard:', err)
			setCopyStatus('failed')
			setTimeout(() => setCopyStatus('idle'), 2000)
		}
	}

	const handleBeginLink = () => {
		setCopyStatus('idle')
		beginLinkMutation.mutate()
	}

	const handleManualCopy = () => {
		if (command) {
			copyToClipboard(command)
		}
	}

	const handleDialogOpenChange = (newState: boolean) => {
		if (!newState) {
			// Reset state and cancel any pending link when closing dialog
			if (command) {
				cancelLinkMutation.mutate()
			}
			setCommand(null)
			setCopyStatus('idle')
		}
		onOpenChange?.(newState)
	}

	const getCopyButtonContent = () => {
		switch (copyStatus) {
			case 'copied':
				return (
					<>
						<Icons.Check className="h-4 w-4" />
						Copied!
					</>
				)
			case 'failed':
				return (
					<>
						<Icons.AlertCircle className="h-4 w-4" />
						Failed
					</>
				)
			default:
				return (
					<>
						<Icons.Copy className="h-4 w-4" />
						Copy
					</>
				)
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange}>
			<DialogTrigger asChild>
				{children}
			</DialogTrigger>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Link Steam Account</DialogTitle>
					<DialogDescription>
						Link your Steam account to your Discord profile for enhanced features and permissions.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{!command
						? (
							<div className="space-y-4">
								<Alert>
									<Icons.Info className="h-4 w-4" />
									<AlertDescription>
										Generate a command to execute in-game. It will be automatically copied to your clipboard.
									</AlertDescription>
								</Alert>

								<div className="flex justify-center">
									<Button
										onClick={handleBeginLink}
										disabled={beginLinkMutation.isPending}
										size="lg"
									>
										{beginLinkMutation.isPending
											? (
												<>
													<Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />
													Generating...
												</>
											)
											: (
												<>
													<Icons.Link className="mr-2 h-4 w-4" />
													Generate Link Command
												</>
											)}
									</Button>
								</div>
							</div>
						)
						: (
							<div className="space-y-4">
								<Alert>
									<Icons.CheckCircle className="h-4 w-4" />
									<AlertDescription className="flex items-center justify-between">
										<span>
											Command <code className="bg-muted px-1 py-0.5 rounded text-xs">{command}</code> was copied to your clipboard!
										</span>
										<Button
											variant="outline"
											size="sm"
											className={cn(
												'ml-2',
												copyStatus === 'copied' && 'bg-green-100 border-green-300 text-green-700',
												copyStatus === 'failed' && 'bg-red-100 border-red-300 text-red-700',
											)}
											onClick={handleManualCopy}
											disabled={copyStatus !== 'idle'}
										>
											{getCopyButtonContent()}
										</Button>
									</AlertDescription>
								</Alert>

								<div className="space-y-3">
									<div className="space-y-2">
										<div className="text-sm font-medium">Instructions:</div>
										<ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
											<li>Join a gameserver linked to this instance of squad-layer-manager</li>
											<li>Paste the command into the in-game console (~ key)</li>
											<li>Check if the command was executed successfully</li>
										</ol>
									</div>
								</div>
							</div>
						)}

					{beginLinkMutation.error && (
						<Alert variant="destructive">
							<Icons.AlertTriangle className="h-4 w-4" />
							<AlertDescription>
								Failed to generate link command. Please try again.
							</AlertDescription>
						</Alert>
					)}

					{cancelLinkMutation.error && (
						<Alert variant="destructive">
							<Icons.AlertTriangle className="h-4 w-4" />
							<AlertDescription>
								Failed to cancel link. Please try again.
							</AlertDescription>
						</Alert>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}
