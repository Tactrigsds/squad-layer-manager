import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as Messages from '@/messages'
import * as CMD from '@/models/command.models'
import * as SettingsClient from '@/systems/settings.client'
import { Copy, HelpCircle } from 'lucide-react'
import * as React from 'react'

interface CommandsHelpDialogProps {
	children?: React.ReactNode
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

export default function CommandsHelpDialog({ children, open, onOpenChange }: CommandsHelpDialogProps) {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)

	if (!settings) {
		return null
	}

	const commands = settings.commands

	const copyConsoleCommand = async (consoleCommand: string) => {
		try {
			await navigator.clipboard.writeText(consoleCommand)
			toast('Copied to clipboard', { description: consoleCommand })
		} catch {
			toast.error('Failed to copy', { description: 'Could not copy command to clipboard' })
		}
	}

	const copyCommandToClipboard = (cmd: CMD.CommandConfig, cmdString: string) => {
		const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'
		return copyConsoleCommand(`${chatScope} ${cmdString}`)
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
					<DialogDescription asChild>
						<ul className="list-disc pl-4 space-y-1">
							<li>
								If scope is <code>admin</code>, the command can only be used in admin chat, and so on.
							</li>
							<li>Players can be matched by ID (Steam, EOS, Epic) or by username match (see below)</li>
							<li>All matching (usernames, flag names) is case-insensitive with non-ASCII and whitespace stripped.</li>
						</ul>
					</DialogDescription>
				</DialogHeader>
				<ScrollArea className="max-h-[60vh] pr-4">
					<div className="space-y-4">
						{Object.entries(commands).map(([cmdName, cmd]) => {
							const cmdId = cmdName as CMD.CommandId
							const argObject = Object.fromEntries(
								(CMD.COMMAND_DECLARATIONS[cmdId].args as readonly CMD.ArgDef[]).map(arg => {
									if (arg.kind === 'squad') return [arg.name, '[team] <squad>']
									const optional = (arg.kind !== 'broadcast' && arg.optional) ?? false
									return [arg.name, optional ? `[${arg.name}]` : ('<' + arg.name + '>')]
								}),
							)
							return (
								<div key={cmdName} className="space-y-2">
									<div className="flex items-center gap-2">
										<div className="flex-1">
											<div className="flex flex-wrap items-center gap-1">
												{CMD.buildCommand(cmdId, argObject, commands, settings.commandPrefix, true).map((
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
											{cmd.scopes.map((scope) => (
												<Badge
													key={scope}
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
						{settings.timeoutCommandAliases.length > 0 && (
							<div className="space-y-2">
								<h3 className="text-sm font-semibold">Timeout aliases</h3>
								<p className="text-sm text-muted-foreground">
									Fixed-duration kick shortcuts, usable in admin chat only. Each kicks a player with its configured timeout.
								</p>
								{settings.timeoutCommandAliases.map((alias) => {
									const cmdString = `${settings.commandPrefix}${alias.string} ${CMD.formatArgSignature(CMD.TIMEOUT_ALIAS_ARG_DEFS)}`
									return (
										<div key={alias.string} className="space-y-1">
											<div className="flex items-center gap-1">
												<code className="px-2 py-1 bg-muted rounded text-sm font-mono">{cmdString}</code>
												<Button
													variant="ghost"
													size="sm"
													className="h-6 w-6 p-0"
													onClick={() => copyConsoleCommand(`ChatToAdmin ${cmdString}`)}
												>
													<Copy className="h-3 w-3" />
												</Button>
											</div>
											<p className="text-sm text-muted-foreground">
												{Messages.GENERAL.command.timeoutAliasDescription(alias.duration)}
											</p>
										</div>
									)
								})}
							</div>
						)}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	)
}
