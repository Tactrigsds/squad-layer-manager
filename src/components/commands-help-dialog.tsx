import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import * as CmdGroups from '@/lib/command-groups'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as Messages from '@/messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'
import * as SettingsClient from '@/systems/settings.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as Icons from 'lucide-react'
import * as React from 'react'

interface CommandsHelpDialogProps {
	children?: React.ReactNode
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

type TimeoutAlias = PublicSettings['timeoutCommandAliases'][number]

// one listing in the help body, anchored by `id` so the table of contents can scroll it into view
type Entry =
	| { kind: 'command'; id: string; label: string; search: string; cmdId: CMD.CommandId; cmd: CMD.CommandConfig }
	| { kind: 'alias'; id: string; label: string; search: string; alias: TimeoutAlias }

type Section = { id: string; label: string; entries: Entry[] }

const TIMEOUT_ALIASES_SECTION_ID = 'command-group:timeout-aliases'

// the reason arg (if any) for a command's args; drives the applicable-reasons listing
function reasonArgOf(args: readonly CMD.ArgDef[]) {
	return args.find((a): a is Extract<CMD.ArgDef, { kind: 'reason' | 'preset-reason' }> => a.kind === 'reason' || a.kind === 'preset-reason')
}

// lists the configured reasons applicable to a reason arg's action, plus whether free-text is accepted
function CommandReasons(
	{ reasonArg, reasons }: { reasonArg: Extract<CMD.ArgDef, { kind: 'reason' | 'preset-reason' }>; reasons: AAR.AdminActionReason[] },
) {
	const applicable = AAR.reasonsForAction(reasons, reasonArg.action)
	// `reason` (rest) kind accepts a custom message when 2+ tokens are given; `preset-reason` is preset-only
	const allowCustom = reasonArg.kind === 'reason'
	if (applicable.length === 0 && !allowCustom) return null
	return (
		<div className="flex flex-wrap items-center gap-1">
			<span className="text-xs text-muted-foreground">Reasons:</span>
			{applicable.map((reason) => (
				<Badge key={reason.label} variant="secondary" className="text-xs" title={AAR.reasonText(reasonArg.action, reason)}>
					{reason.aliases.length > 0 ? `${reason.label} (${reason.aliases.join(', ')})` : reason.label}
				</Badge>
			))}
			{allowCustom && <span className="text-xs text-muted-foreground">{applicable.length > 0 ? 'or custom text' : 'custom text only'}
			</span>}
		</div>
	)
}

function CopyableCommand({ cmdString, chatScope }: { cmdString: string; chatScope: 'ChatToAdmin' | 'ChatToAll' }) {
	const copy = async () => {
		const consoleCommand = `${chatScope} ${cmdString}`
		try {
			await navigator.clipboard.writeText(consoleCommand)
			toast('Copied to clipboard', { description: consoleCommand })
		} catch {
			toast.error('Failed to copy', { description: 'Could not copy command to clipboard' })
		}
	}
	return (
		<div className="flex items-center gap-1">
			<code className="px-2 py-1 bg-muted rounded text-sm font-mono">{cmdString}</code>
			<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={copy}>
				<Icons.Copy className="h-3 w-3" />
			</Button>
		</div>
	)
}

function CommandEntry(
	{ entry, settings }: { entry: Extract<Entry, { kind: 'command' }>; settings: PublicSettings },
) {
	const { cmdId, cmd } = entry
	const args = CMD.COMMAND_DECLARATIONS[cmdId].args as readonly CMD.ArgDef[]
	const reasonArg = reasonArgOf(args)
	const argObject = Object.fromEntries(args.map(arg => [arg.name, CMD.formatArg(arg, settings.requireReasonFor)]))
	const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'
	return (
		<div id={entry.id} data-cmd-anchor className="space-y-2 scroll-mt-9">
			<div className="flex items-center gap-2">
				<div className="flex flex-1 flex-wrap items-center gap-1">
					{CMD.buildCommand(cmdId, argObject, settings.commands, true).map((cmdString) => (
						<CopyableCommand key={cmdString} cmdString={cmdString} chatScope={chatScope} />
					))}
				</div>
				{!cmd.enabled && <Badge variant="destructive" className="text-xs">Disabled</Badge>}
			</div>
			<p className="text-sm text-muted-foreground">{Messages.GENERAL.command.descriptions[cmdId]}</p>
			{cmd.scopes.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					<span className="text-xs text-muted-foreground">Scopes:</span>
					{cmd.scopes.map((scope) => <Badge key={scope} variant="outline" className="text-xs">{scope}</Badge>)}
				</div>
			)}
			{reasonArg && <CommandReasons reasonArg={reasonArg} reasons={settings.adminActionReasons} />}
		</div>
	)
}

function AliasEntry(
	{ entry, settings }: { entry: Extract<Entry, { kind: 'alias' }>; settings: PublicSettings },
) {
	const cmdString = `${entry.alias.string} ${CMD.formatArgSignature(CMD.TIMEOUT_ALIAS_ARG_DEFS, settings.requireReasonFor)}`
	return (
		<div id={entry.id} data-cmd-anchor className="space-y-1 scroll-mt-9">
			<CopyableCommand cmdString={cmdString} chatScope="ChatToAdmin" />
			<p className="text-sm text-muted-foreground">{Messages.GENERAL.command.timeoutAliasDescription(entry.alias.duration)}</p>
		</div>
	)
}

// tracks which entry anchor sits at the top of the help body, so the matching TOC row can be highlighted
function useActiveEntry(scrollRef: React.RefObject<HTMLDivElement | null>, deps: unknown): string | null {
	const [activeId, setActiveId] = React.useState<string | null>(null)
	React.useEffect(() => {
		const container = scrollRef.current
		if (!container) return
		let raf = 0
		const compute = () => {
			raf = 0
			// the fold sits below the pinned group header, so the entry visible beneath it wins
			const fold = container.getBoundingClientRect().top + 40
			const anchors = container.querySelectorAll<HTMLElement>('[data-cmd-anchor]')
			let current: string | null = null
			for (const el of anchors) {
				if (el.getBoundingClientRect().top <= fold) current = el.id
			}
			if (!current && anchors.length > 0) current = anchors[0].id
			setActiveId(current)
		}
		const onScroll = () => {
			if (raf === 0) raf = requestAnimationFrame(compute)
		}
		container.addEventListener('scroll', onScroll, { passive: true })
		compute()
		return () => {
			container.removeEventListener('scroll', onScroll)
			if (raf !== 0) cancelAnimationFrame(raf)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scrollRef, deps])
	return activeId
}

export default function CommandsHelpDialog({ children, open, onOpenChange }: CommandsHelpDialogProps) {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const [query, setQuery] = React.useState('')
	const scrollRef = React.useRef<HTMLDivElement>(null)

	const sections: Section[] = React.useMemo(() => {
		if (!settings) return []
		const descriptions = Messages.GENERAL.command.descriptions
		const sections = CmdGroups.splitCommandsByGroup(Object.keys(settings.commands) as CMD.CommandId[]).map(({ group, ids }) => ({
			id: `command-group:${group.slug}`,
			label: group.label,
			entries: ids.map((cmdId): Entry => {
				const cmd = settings.commands[cmdId]
				return {
					kind: 'command',
					id: `command:${cmdId}`,
					label: cmd.strings[0] ?? cmdId,
					search: [cmdId, ...cmd.strings, descriptions[cmdId], group.label].join(' ').toLowerCase(),
					cmdId,
					cmd,
				}
			}),
		}))
		if (settings.timeoutCommandAliases.length > 0) {
			sections.push({
				id: TIMEOUT_ALIASES_SECTION_ID,
				label: 'Timeout Aliases',
				entries: settings.timeoutCommandAliases.map((alias): Entry => ({
					kind: 'alias',
					id: `timeout-alias:${alias.string}`,
					label: alias.string,
					search: `${alias.string} timeout alias kick`,
					alias,
				})),
			})
		}
		return sections
	}, [settings])

	const q = query.trim().toLowerCase()
	// a section-label match keeps the whole section, so searching "moderation" lists everything under it
	const visible = q
		? sections
			.map((s) => (s.label.toLowerCase().includes(q) ? s : { ...s, entries: s.entries.filter((e) => e.search.includes(q)) }))
			.filter((s) => s.entries.length > 0)
		: sections

	const activeId = useActiveEntry(scrollRef, visible.map((s) => s.id).join(','))

	if (!settings) return null

	function scrollToEntry(id: string) {
		scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children || (
					<Button variant="outline" size="sm">
						<Icons.HelpCircle className="h-4 w-4 mr-2" />
						Help
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="flex flex-col max-w-4xl h-[85vh]">
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
				<div className="flex gap-4 flex-1 min-h-0">
					<aside className="flex flex-col w-52 shrink-0 min-h-0 border-r pr-2">
						<div className="relative shrink-0 pb-2">
							<Icons.Search className="absolute left-2 top-[0.9rem] -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<Input className="h-8 pl-7" placeholder="Search commands…" onChange={(e) => setQuery(e.target.value)} />
						</div>
						<nav className="flex-1 min-h-0 overflow-y-auto">
							{visible.length === 0
								? <p className="text-sm text-muted-foreground px-1">No matches.</p>
								: (
									<ul className="space-y-2">
										{visible.map((section) => (
											<li key={section.id}>
												<p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.label}</p>
												<ul>
													{section.entries.map((entry) => (
														<li key={entry.id}>
															<button
																type="button"
																onClick={() => scrollToEntry(entry.id)}
																className={cn(
																	'block w-full truncate rounded px-1 py-0.5 text-left font-mono text-sm hover:text-foreground',
																	entry.id === activeId ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
																)}
																title={entry.label}
															>
																{entry.label}
															</button>
														</li>
													))}
												</ul>
											</li>
										))}
									</ul>
								)}
						</nav>
					</aside>
					<div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto pr-4">
						{visible.map((section) => (
							<section key={section.id}>
								<h3 className="sticky top-0 z-10 bg-background py-1 text-sm font-semibold">{section.label}</h3>
								{section.id === TIMEOUT_ALIASES_SECTION_ID && (
									<div className="space-y-2 pb-2">
										<p className="text-sm text-muted-foreground">
											Fixed-duration kick shortcuts, usable in admin chat only. Each kicks a player with its configured timeout.
										</p>
										<CommandReasons reasonArg={reasonArgOf(CMD.TIMEOUT_ALIAS_ARG_DEFS)!} reasons={settings.adminActionReasons} />
									</div>
								)}
								<div className="space-y-4 pb-4">
									{section.entries.map((entry) =>
										entry.kind === 'command'
											? <CommandEntry key={entry.id} entry={entry} settings={settings} />
											: <AliasEntry key={entry.id} entry={entry} settings={settings} />
									)}
								</div>
							</section>
						))}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
