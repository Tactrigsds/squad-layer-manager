import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/hooks/use-toast'
import * as Messages from '@/messages'
import * as CMD from '@/models/command.models'
import { useConfig } from '@/systems.client/config.client'
import { Copy, HelpCircle } from 'lucide-react'
import * as React from 'react'

interface CommandsHelpDialogProps {
	children?: React.ReactNode
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

export default function CommandsHelpDialog({ children, open, onOpenChange }: CommandsHelpDialogProps) {
	const config = useConfig()
	const { toast } = useToast()

	if (!config) {
		return null
	}

	const commands = config.commands

	const copyCommandToClipboard = async (cmd: CMD.CommandConfig, cmdString: string) => {
		const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'
		const consoleCommand = `${chatScope} ${cmdString}`

		try {
			await navigator.clipboard.writeText(consoleCommand)
			toast({
				title: 'Copied to clipboard',
				description: consoleCommand,
			})
		} catch {
			toast({
				title: 'Failed to copy',
				description: 'Could not copy command to clipboard',
				variant: 'destructive',
			})
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children || (
					<Button variant="outline" size="sm">
						<HelpCircle className="h-4 w-4 mr-2" />
						Help
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-2xl max-h-[80vh]">
				<DialogHeader>
					<DialogTitle>Available Ingame Commands</DialogTitle>
					<DialogDescription>
						If scope is 'admin', the command can only be used in admin chat, and so on.
					</DialogDescription>
				</DialogHeader>
				<ScrollArea className="max-h-[60vh] pr-4">
					<div className="space-y-4">
						{Object.entries(commands).map(([cmdName, cmd]) => {
							const cmdId = cmdName as CMD.CommandId
							const argObject = Object.fromEntries(
								CMD.COMMAND_DECLARATIONS[cmdId].args.map(arg => {
									const name = typeof arg === 'string' ? arg : arg.name
									const optional = typeof arg === 'string' ? false : arg.optional
									return [name, optional ? `[${name}]` : ('<' + name + '>')]
								}),
							)
							return (
								<div key={cmdName} className="space-y-2">
									<div className="flex items-center gap-2">
										<div className="flex-1">
											<div className="flex flex-wrap items-center gap-1">
												{CMD.buildCommand(cmdId, argObject, commands, config.commandPrefix, true).map((
													cmdString,
												) => (
													<div key={cmdString} className="flex items-center gap-1">
														<code className="px-2 py-1 bg-muted rounded text-sm font-mono">
															{cmdString}
														</code>
														<Button
															variant="ghost"
															size="sm"
															className="h-6 w-6 p-0"
															onClick={() => copyCommandToClipboard(cmd, cmdString)}
														>
															<Copy className="h-3 w-3" />
														</Button>
													</div>
												))}
											</div>
										</div>
										{!cmd.enabled && (
											<Badge variant="destructive" className="text-xs">
												Disabled
											</Badge>
										)}
									</div>
									<p className="text-sm text-muted-foreground">
										{Messages.GENERAL.command.descriptions[cmdName as CMD.CommandId]}
									</p>
									{cmd.scopes.length > 0 && (
										<div className="flex flex-wrap items-center gap-1">
											<span className="text-xs text-muted-foreground">Scopes:</span>
											{cmd.scopes.map((scope, scopeIndex) => (
												<Badge
													key={scopeIndex}
													variant="outline"
													className="text-xs"
												>
													{scope}
												</Badge>
											))}
										</div>
									)}
								</div>
							)
						})}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	)
}
