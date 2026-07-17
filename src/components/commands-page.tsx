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
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
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

// the sections that re-list commands already shown under their own section, rather than holding any of their own
const SHORTCUT_SECTION_IDS: ReadonlySet<string> = new Set([PINNED_SECTION_ID, QUICK_REF_SECTION_ID])

// Each scope is shown as its chat channel already is elsewhere in the app: admin-only in the admin blue with a shield
// (as on an admin player and the chat box's admin target), public in ChatAll's white. Tinted outline rather than a
// solid fill -- it's the same treatment the chat box gives its channels, and a filled badge at this size buried the
// label. The icon does the work at a glance; the colour alone would be carrying too much.
const SCOPE_BADGES: Record<CMD.CommandScope, { icon: React.ComponentType<{ className?: string }>; className: string }> = {
	admin: { icon: Icons.Shield, className: 'border-admin/60 text-admin' },
	public: { icon: Icons.Globe, className: 'border-foreground/40 text-foreground' },
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
				{cmd.scopes.map((scope) => {
					const { icon: ScopeIcon, className } = SCOPE_BADGES[scope]
					return (
						<Badge key={scope} variant="outline" className={cn('gap-1 whitespace-nowrap text-xs', className)}>
							<ScopeIcon className="h-3 w-3" />
							{CMD.COMMAND_SCOPE_LABELS[scope]}
						</Badge>
					)
				})}
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
	// Where the arrow keys are. Kept as state rather than read back off the scroll position: the highlight otherwise
	// follows whatever sits at the top of the body, which only updates on a real user scroll -- so each press would
	// re-read the entry it started from and the cursor would never leave it.
	const [cursorId, setCursorId] = React.useState<string | null>(null)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const rootRef = React.useRef<HTMLDivElement>(null)
	const navRef = React.useRef<HTMLElement>(null)
	// set while scrollToEntry runs, so the body's own scrolling isn't mistaken for the user taking over
	const scrollingToEntry = React.useRef(false)
	const stickyZIndex = useZIndex(ZI_OFFSETS.STICKYGROUP_FLOOR)

	// The body scrolls inside its own container, so a wheel anywhere else -- the margins either side of the centred
	// column, the page header, the search box -- lands on nothing and the list sits still. Forward those to the body.
	// Whatever scrolls itself keeps its own wheel: the body, and the table of contents while it has somewhere to go.
	React.useEffect(() => {
		const root = rootRef.current
		const scroller = scrollRef.current
		if (!root || !scroller) return
		const onWheel = (e: WheelEvent) => {
			const target = e.target as Node
			if (scroller.contains(target)) return
			const nav = navRef.current
			if (nav?.contains(target) && nav.scrollHeight > nav.clientHeight) return
			// forwarding the delta means taking the event over, so this listener can't be passive
			e.preventDefault()
			scroller.scrollTop += e.deltaY
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		return () => root.removeEventListener('wheel', onWheel)
		// the refs only exist once settings has rendered the page, so this can't bind on the first render
	}, [settings])

	const sections = React.useMemo(() => settings ? buildSections(settings, pinnedCommands) : [], [settings, pinnedCommands])
	const pinnedSet = React.useMemo(() => new Set(pinnedCommands), [pinnedCommands])

	const q = query.trim().toLowerCase()
	// a section-label match keeps the whole section, so searching "moderation" lists everything under it
	const visible = q
		// Pinned and quick reference are shortcuts into the sections below, not content of their own, so a search hit
		// lands in each of them as well as its real section -- three copies of one command. Searching is already the
		// direct way to find something, so the shortcuts drop out and every hit appears exactly once.
		? sections
			.filter((s) => !SHORTCUT_SECTION_IDS.has(s.id))
			.map((s) => (s.label.toLowerCase().includes(q) ? s : { ...s, entries: s.entries.filter((e) => e.search.includes(q)) }))
			.filter((s) => s.entries.length > 0)
		: sections

	const activeId = useActiveEntry(scrollRef, visible.map((s) => s.id).join(','))
	// the cursor owns the highlight while arrowing; otherwise it follows the entry at the top of the body
	const highlightId = cursorId ?? activeId

	if (!settings) return null

	function scrollToEntry(id: string, behavior: ScrollBehavior = 'smooth') {
		scrollingToEntry.current = true
		scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior })
		requestAnimationFrame(() => {
			scrollingToEntry.current = false
		})
	}

	// Up/down walk the results from the search box, so a search can be narrowed and swept without leaving the input.
	// Instant rather than smooth: a smooth scroll is still travelling when the next press lands, and holding a key
	// would then be scheduling scrolls faster than they finish.
	function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		const ids = visible.flatMap((section) => section.entries.map((entry) => entry.id))
		if (ids.length === 0) return
		// otherwise the caret jumps to either end of the query
		e.preventDefault()
		const delta = e.key === 'ArrowDown' ? 1 : -1
		// picks up from wherever the body was scrolled to, so arrowing after a scroll continues from what's on screen
		const current = highlightId ? ids.indexOf(highlightId) : -1
		// with nothing highlighted yet, down starts at the top of the list and up starts at the bottom
		const next = current === -1
			? (delta === 1 ? 0 : ids.length - 1)
			: Math.min(Math.max(current + delta, 0), ids.length - 1)
		setCursorId(ids[next])
		scrollToEntry(ids[next], 'instant')
	}

	return (
		// the height has to be pinned here, as the settings page does: _app only bounds its own height on the dashboard
		// route, so flex-1/min-h-0 alone leaves this growing to fit and the body scrolling the window instead of itself
		// -- which silently costs the sticky headers and the scroll-tracked highlight. 6rem = the nav bar + _app's padding.
		<div ref={rootRef} className="flex h-[calc(100dvh-6rem)] w-full justify-center">
			<div className="flex h-full w-full max-w-6xl flex-col">
				<header className="shrink-0 pb-3">
					<h1 className="text-xl font-semibold">Ingame Commands</h1>
					<p className="pt-1 text-sm text-muted-foreground">
						Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces.
					</p>
				</header>
				<div className="flex gap-4 flex-1 min-h-0">
					<aside className="flex flex-col w-52 shrink-0 min-h-0 border-r pr-2">
						<div className="relative shrink-0 pb-2">
							<Icons.Search className="absolute left-2 top-[0.9rem] -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<Input
								className="h-8 pl-7"
								placeholder="Search commands…"
								onChange={(e) => {
									setQuery(e.target.value)
									setCursorId(null)
								}}
								onKeyDown={onSearchKeyDown}
							/>
						</div>
						<nav ref={navRef} className="flex-1 min-h-0 overflow-y-auto">
							{visible.length === 0
								? <p className="text-sm text-muted-foreground px-1">No matches.</p>
								: (
									<ul>
										{visible.map((section) => (
											// mirrors the body's sections -- label, rule, indented entries -- so the two columns read as the same split
											<li key={section.id} className="pt-4 first:pt-0">
												<p className="border-b border-border px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-foreground">
													{section.label}
												</p>
												<ul className="space-y-px pl-2 pt-1">
													{section.entries.map((entry) => (
														<li key={entry.id}>
															<button
																type="button"
																onClick={() => scrollToEntry(entry.id)}
																className={cn(
																	'block w-full truncate rounded px-1 py-0.5 text-left font-mono text-sm hover:text-foreground',
																	entry.id === highlightId ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
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
					<div
						ref={scrollRef}
						className="flex-1 min-w-0 overflow-y-auto pr-4"
						onScroll={() => {
							if (!scrollingToEntry.current) setCursorId(null)
						}}
					>
						{visible.map((section) => (
							<section key={section.id} className="pb-8 last:pb-2">
								{
									/* the header stays legible over the entries it scrolls across, so it needs to be opaque and to own the
							    full width -- hence the negative margin pulling it out to the scroll container's padding */
								}
								<h2
									style={{ zIndex: stickyZIndex }}
									className="sticky top-0 -mx-1 mb-2 border-b-2 border-border bg-background px-1 pb-1.5 pt-1 text-base font-semibold tracking-tight"
								>
									{section.label}
								</h2>
								{section.blurb && <p className="pb-3 text-sm text-muted-foreground">{section.blurb}</p>}
								{
									/* dividers between commands: a section is a long stack of similar-looking rows, and the arg signatures
							    wrap, which left the boundary between two commands ambiguous on spacing alone */
								}
								<div className="divide-y divide-border/70">
									{section.entries.map((entry) => (
										<div key={entry.id} className="py-3 first:pt-0 last:pb-0">
											{entry.kind === 'command'
												? <CommandEntry entry={entry} settings={settings} pinned={pinnedSet.has(entry.cmdId)} />
												: <AliasEntry entry={entry} settings={settings} />}
										</div>
									))}
								</div>
							</section>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}
