import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as Messages from '@/messages'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as SettingsClient from '@/systems/settings.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as Icons from 'lucide-react'
import * as React from 'react'

type CommandAlias = PublicSettings['commandAliases'][number]

// one listing in the page body. `key` identifies the command/alias itself; `id` is the DOM anchor, which also carries
// the section, since a pinned or quick-reference command is listed again under its own section.
type Entry =
	| { kind: 'command'; key: string; id: string; label: string; search: string; cmdId: CMD.CommandId; cmd: CMD.CommandConfig }
	| { kind: 'alias'; key: string; id: string; label: string; search: string; alias: CommandAlias }

type Section = { id: string; label: string; blurb?: string; entries: Entry[] }

const PINNED_SECTION_ID = 'section:pinned'
const QUICK_REF_SECTION_ID = 'section:quick-reference'
const ALIASES_SECTION_ID = 'section:aliases'

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
			<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={copy} aria-label={`Copy ${cmdString}`}>
				<Icons.Copy className="h-3 w-3" />
			</Button>
		</div>
	)
}

function PinButton({ cmdId, pinned }: { cmdId: CMD.CommandId; pinned: boolean }) {
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-6 w-6 p-0 shrink-0"
			aria-pressed={pinned}
			aria-label={pinned ? 'Unpin command' : 'Pin command'}
			title={pinned ? 'Unpin from the top of this page' : 'Pin to the top of this page'}
			onClick={() => ClientOnlySettings.Actions.toggleCommandPinned(cmdId)}
		>
			<Icons.Pin className={cn('h-3.5 w-3.5', pinned ? 'fill-current' : 'text-muted-foreground')} />
		</Button>
	)
}

// the per-argument breakdown and worked examples, shown when a command is expanded. Both are derived from the
// command's declaration plus the installation's configured reasons/broadcasts (see command-help.models).
function CommandDetails({ cmdId, cmd, settings }: { cmdId: CMD.CommandId; cmd: CMD.CommandConfig; settings: PublicSettings }) {
	const seeds: CMDH.ExampleSeeds = { reasons: settings.adminActionReasons, broadcasts: settings.broadcasts }
	const args = CMDH.describeArgs(cmdId, seeds, settings.requireReasonFor)
	const examples = CMDH.buildExamples(cmdId, cmd, seeds, settings.requireReasonFor)
	const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'

	return (
		<div className="space-y-3 border-l-2 pl-3 ml-1">
			{args.length > 0 && (
				<dl className="space-y-2">
					{args.map((arg) => (
						<div key={arg.name} className="text-sm">
							<dt className="flex flex-wrap items-baseline gap-2">
								<code className="font-mono text-xs bg-muted rounded px-1 py-0.5">
									{arg.optional ? `[${arg.name}]` : `<${arg.name}>`}
								</code>
								<span className="text-xs text-muted-foreground font-mono">{arg.syntax}</span>
								{arg.optional && <span className="text-xs text-muted-foreground">optional</span>}
							</dt>
							<dd className="text-xs text-muted-foreground pt-0.5">
								{arg.description}
								{arg.presets.length > 0 && (
									<span className="flex flex-wrap items-center gap-1 pt-1">
										<span>Configured:</span>
										{arg.presets.map((preset) => <Badge key={preset} variant="secondary" className="text-xs">{preset}</Badge>)}
									</span>
								)}
							</dd>
						</div>
					))}
				</dl>
			)}
			<div className="space-y-1">
				<p className="text-xs font-medium text-muted-foreground">Examples</p>
				{examples.map((example) => (
					<div key={example.command} className="flex flex-wrap items-center gap-2">
						<CopyableCommand cmdString={example.command} chatScope={chatScope} />
						<span className="text-xs text-muted-foreground">{example.note}</span>
					</div>
				))}
			</div>
		</div>
	)
}

function CommandEntry(
	{ entry, settings, pinned }: { entry: Extract<Entry, { kind: 'command' }>; settings: PublicSettings; pinned: boolean },
) {
	const { cmdId, cmd } = entry
	const [open, setOpen] = React.useState(false)
	const args = CMD.COMMAND_DECLARATIONS[cmdId].args as readonly CMD.ArgDef[]
	const argObject = Object.fromEntries(args.map(arg => [arg.name, CMD.formatArg(arg, settings.requireReasonFor)]))
	const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'
	return (
		<Collapsible open={open} onOpenChange={setOpen} id={entry.id} data-cmd-anchor className="space-y-2 scroll-mt-9">
			<div className="flex items-center gap-2">
				<PinButton cmdId={cmdId} pinned={pinned} />
				<div className="flex flex-1 flex-wrap items-center gap-1">
					{CMD.buildCommand(cmdId, argObject, settings.commands, true).map((cmdString) => (
						<CopyableCommand key={cmdString} cmdString={cmdString} chatScope={chatScope} />
					))}
				</div>
				{!cmd.enabled && <Badge variant="destructive" className="text-xs">Disabled</Badge>}
				{cmd.scopes.map((scope) => (
					<Badge key={scope} variant="outline" className="text-xs whitespace-nowrap">{CMD.COMMAND_SCOPE_LABELS[scope]}</Badge>
				))}
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-muted-foreground">
						{open ? <Icons.ChevronDown className="h-3 w-3" /> : <Icons.ChevronRight className="h-3 w-3" />}
						Details
					</Button>
				</CollapsibleTrigger>
			</div>
			<p className="text-sm text-muted-foreground">{Messages.GENERAL.command.descriptions[cmdId]}</p>
			<CollapsibleContent>
				<CommandDetails cmdId={cmdId} cmd={cmd} settings={settings} />
			</CollapsibleContent>
		</Collapsible>
	)
}

// an alias takes no arguments, so its listing is the shortcut itself, what it expands to, and (when the command it
// points at is disabled or no longer exists) why it currently does nothing
function AliasEntry({ entry, settings }: { entry: Extract<Entry, { kind: 'alias' }>; settings: PublicSettings }) {
	const res = CMD.resolveAliasCommand(entry.alias.command, settings.commands)
	const target = res.code === 'ok' ? settings.commands[res.cmdId] : undefined
	const unusable = res.code !== 'ok' ? 'Unavailable' : !target!.enabled ? 'Disabled' : undefined
	const chatScope = target?.scopes.includes('public') && !target.scopes.includes('admin') ? 'ChatToAll' : 'ChatToAdmin'
	return (
		<div id={entry.id} data-cmd-anchor className="space-y-1 scroll-mt-9">
			<div className="flex items-center gap-2">
				<CopyableCommand cmdString={entry.alias.alias} chatScope={chatScope} />
				{unusable && <Badge variant="destructive" className="text-xs">{unusable}</Badge>}
			</div>
			<p className="text-sm text-muted-foreground">{Messages.GENERAL.command.aliasDescription(entry.alias.command)}</p>
			{res.code === 'ok' && <p className="text-sm text-muted-foreground">{Messages.GENERAL.command.descriptions[res.cmdId]}</p>}
			{res.code === 'err:unknown-command' && <p className="text-sm text-destructive">{res.msg}</p>}
		</div>
	)
}

// tracks which entry anchor sits at the top of the page body, so the matching TOC row can be highlighted
function useActiveEntry(scrollRef: React.RefObject<HTMLDivElement | null>, deps: unknown): string | null {
	const [activeId, setActiveId] = React.useState<string | null>(null)
	React.useEffect(() => {
		const container = scrollRef.current
		if (!container) return
		let raf = 0
		const compute = () => {
			raf = 0
			// the fold sits below the pinned section header, so the entry visible beneath it wins
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

function commandEntry(sectionId: string, cmdId: CMD.CommandId, cmd: CMD.CommandConfig, sectionLabel: string): Entry {
	return {
		kind: 'command',
		key: cmdId,
		id: `${sectionId}/command:${cmdId}`,
		label: cmd.strings[0] ?? cmdId,
		search: [cmdId, ...cmd.strings, Messages.GENERAL.command.descriptions[cmdId], sectionLabel].join(' ').toLowerCase(),
		cmdId,
		cmd,
	}
}

function aliasEntry(sectionId: string, alias: CommandAlias): Entry {
	return {
		kind: 'alias',
		key: `alias:${alias.alias}`,
		id: `${sectionId}/alias:${alias.alias}`,
		label: alias.alias,
		search: `${alias.alias} ${alias.command} alias shortcut`.toLowerCase(),
		alias,
	}
}

function buildSections(settings: PublicSettings, pinnedCommands: string[]): Section[] {
	const sections: Section[] = []

	// pins are per-browser, so an id can outlive the command it named (a downgrade, or a renamed id)
	const pinned = pinnedCommands.filter((id): id is CMD.CommandId => id in settings.commands)
	if (pinned.length > 0) {
		sections.push({
			id: PINNED_SECTION_ID,
			label: 'Pinned',
			blurb: 'Commands you pinned. Saved in this browser only.',
			entries: pinned.map((cmdId) => commandEntry(PINNED_SECTION_ID, cmdId, settings.commands[cmdId], 'Pinned')),
		})
	}

	const quickRef = CMD.COMMAND_IDS.filter((id) => settings.commands[id].quickReference)
	const quickRefAliases = settings.commandAliases.filter((a) => {
		const res = CMD.resolveAliasCommand(a.command, settings.commands)
		return res.code === 'ok' && settings.commands[res.cmdId].quickReference
	})
	if (quickRef.length > 0 || quickRefAliases.length > 0) {
		sections.push({
			id: QUICK_REF_SECTION_ID,
			label: 'Quick Reference',
			blurb: 'The commands this server marks as everyday ones. These are also what the in-game help command lists on its own.',
			entries: [
				...quickRef.map((cmdId) => commandEntry(QUICK_REF_SECTION_ID, cmdId, settings.commands[cmdId], 'Quick Reference')),
				...quickRefAliases.map((alias) => aliasEntry(QUICK_REF_SECTION_ID, alias)),
			],
		})
	}

	for (const { section, label, ids } of CMDH.splitCommandsBySection(CMD.COMMAND_IDS)) {
		const id = `section:${section}`
		sections.push({
			id,
			label,
			entries: ids.map((cmdId) => commandEntry(id, cmdId, settings.commands[cmdId], label)),
		})
	}

	if (settings.commandAliases.length > 0) {
		sections.push({
			id: ALIASES_SECTION_ID,
			label: 'Aliases',
			blurb:
				'Shortcuts for complete commands. An alias takes no arguments of its own, and runs in the same chats as the command it points at.',
			entries: settings.commandAliases.map((alias) => aliasEntry(ALIASES_SECTION_ID, alias)),
		})
	}

	return sections
}

export default function CommandsPage() {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const pinnedCommands = ZusUtils.useStore(ClientOnlySettings.Store, s => s.pinnedCommands)
	const [query, setQuery] = React.useState('')
	const scrollRef = React.useRef<HTMLDivElement>(null)

	const sections = React.useMemo(() => settings ? buildSections(settings, pinnedCommands) : [], [settings, pinnedCommands])
	const pinnedSet = React.useMemo(() => new Set(pinnedCommands), [pinnedCommands])

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
		<div className="flex flex-col flex-1 min-h-0 w-full max-w-6xl mx-auto">
			<header className="shrink-0 pb-3">
				<h1 className="text-xl font-semibold">Ingame Commands</h1>
				<p className="pt-1 text-sm text-muted-foreground">
					Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces and non-ASCII
					characters.
				</p>
			</header>
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
							<h2 className="sticky top-0 z-10 bg-background py-1 text-sm font-semibold">{section.label}</h2>
							{section.blurb && <p className="pb-2 text-sm text-muted-foreground">{section.blurb}</p>}
							<div className="space-y-4 pb-4">
								{section.entries.map((entry) =>
									entry.kind === 'command'
										? <CommandEntry key={entry.id} entry={entry} settings={settings} pinned={pinnedSet.has(entry.cmdId)} />
										: <AliasEntry key={entry.id} entry={entry} settings={settings} />
								)}
							</div>
						</section>
					))}
				</div>
			</div>
		</div>
	)
}
