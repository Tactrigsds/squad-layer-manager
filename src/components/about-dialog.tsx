import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { globalToast$ } from '@/hooks/use-global-toast'

import { formatVersion } from '@/lib/versioning'
import * as ConfigClient from '@/systems.client/config.client'
import * as UsersClient from '@/systems.client/users.client'
import { Copy, Info } from 'lucide-react'
import * as React from 'react'

interface AboutDialogProps {
	children?: React.ReactNode
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

export default function AboutDialog({ children, open, onOpenChange }: AboutDialogProps) {
	const config = ConfigClient.useConfig()
	const user = UsersClient.useLoggedInUser()
	if (!config || !user) return null

	const versionText = [
		(config.PUBLIC_GIT_BRANCH || config.PUBLIC_GIT_SHA)
		&& `App Version: ${formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)}`,
		config.layersVersion && `Layer Pool Version: ${config.layersVersion}`,
		user.username && `Logged in as: ${user.username}`,
		config.wsClientId && `WebSocket Client ID: ${config.wsClientId}`,
	].filter(Boolean).join('\n')

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children || (
					<Button variant="outline" size="sm">
						<Info className="h-4 w-4 mr-2" />
						About
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-max">
				<DialogHeader>
					<DialogTitle>About</DialogTitle>
					<DialogDescription>
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<p className="text-sm">
						Squad Layer Manager(SLM) is a tool for managing the upcoming layers of a squad server. and other things also.
					</p>
					<div className="text-sm space-y-2">
						{config.repoUrl && (
							<div className="flex flex-col space-y-1">
								<span className="font-semibold">Repository:</span>
								<a
									href={config.repoUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="text-blue-600 hover:underline"
								>
									{config.repoUrl}
								</a>
							</div>
						)}
						{config.issuesUrl && (
							<div className="flex flex-col space-y-1">
								<span className="font-semibold">Report issues here, including the information below:</span>
								<a
									href={config.issuesUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="text-blue-600 hover:underline"
								>
									{config.issuesUrl}
								</a>
							</div>
						)}
						<div className="relative">
							<Textarea
								readOnly
								tabIndex={-1}
								className="text-xs font-mono pr-10 resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
								rows={versionText.split('\n').length}
								value={versionText}
							/>
							<Button
								variant="ghost"
								size="icon"
								className="absolute top-1 right-1 h-6 w-6"
								onClick={async () => {
									await navigator.clipboard.writeText(versionText)
									globalToast$.next({
										title: 'Copied to clipboard',
										description: 'Version information has been copied',
									})
								}}
							>
								<Copy className="h-3 w-3" />
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
