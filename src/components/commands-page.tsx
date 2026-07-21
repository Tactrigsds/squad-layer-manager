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

export function CopyableCommand({ cmdString, chatScope }: { cmdString: string; chatScope: 'ChatToAdmin' | 'ChatToAll' }) {
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
	const seeds: CMDH.ExampleSeeds = { reasons: settings.adminActionReasons }
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
	{ entry, settings, pinned, onLink }: {
		entry: Extract<Entry, { kind: 'command' }>
		settings: PublicSettings
		pinned: boolean
		onLink: (id: string) => void
	},
) {
	const { cmdId, cmd } = entry
	const [open, setOpen] = React.useState(false)
	const args = CMD.COMMAND_DECLARATIONS[cmdId].args as readonly CMD.ArgDef[]
	const argObject = Object.fromEntries(args.map(arg => [arg.name, CMD.formatArg(arg, settings.requireReasonFor)]))
	const chatScope = cmd.scopes.includes('admin') ? 'ChatToAdmin' : 'ChatToAll'
	return (
		<Collapsible open={open} onOpenChange={setOpen} id={entry.id} data-cmd-anchor className="space-y-2">
			<div className="group flex items-center gap-2">
				<PinButton cmdId={cmdId} pinned={pinned} />
				<div className="flex flex-wrap items-center gap-1">
					{CMD.buildCommand(cmdId, argObject, settings.commands, true).map((cmdString) => (
						<CopyableCommand key={cmdString} cmdString={cmdString} chatScope={chatScope} />
					))}
					<AnchorLinkIcon id={entry.id} onNavigate={onLink} label="Link to this command" />
				</div>
				<div className="flex-1" />
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
function AliasEntry(
	{ entry, settings, onLink }: { entry: Extract<Entry, { kind: 'alias' }>; settings: PublicSettings; onLink: (id: string) => void },
) {
	const res = CMD.resolveAliasCommand(entry.alias.command, settings.commands)
	const target = res.code === 'ok' ? settings.commands[res.cmdId] : undefined
	const unusable = res.code !== 'ok' ? 'Unavailable' : !target!.enabled ? 'Disabled' : undefined
	const chatScope = target?.scopes.includes('public') && !target.scopes.includes('admin') ? 'ChatToAll' : 'ChatToAdmin'
	return (
		<div id={entry.id} data-cmd-anchor className="space-y-1">
			<div className="group flex items-center gap-2">
				<CopyableCommand cmdString={entry.alias.alias} chatScope={chatScope} />
				<AnchorLinkIcon id={entry.id} onNavigate={onLink} label="Link to this alias" />
				{unusable && <Badge variant="destructive" className="text-xs">{unusable}</Badge>}
			</div>
			<p className="text-sm text-muted-foreground">{Messages.GENERAL.command.aliasDescription(entry.alias.command)}</p>
			{res.code === 'ok' && <p className="text-sm text-muted-foreground">{Messages.GENERAL.command.descriptions[res.cmdId]}</p>}
			{res.code === 'err:unknown-command' && <p className="text-sm text-destructive">{res.msg}</p>}
		</div>
	)
}

// The entry id in the URL fragment, if any. Entry ids are section-scoped (a command listed under both Pinned and
// Moderation is two elements), so the fragment names one listing exactly rather than a command in the abstract.
function currentAnchor(): string | null {
	const hash = window.location.hash.slice(1)
	return hash ? decodeURIComponent(hash) : null
}

// Clears any existing anchor mark, then marks `el` when `mark` is set. Landing somewhere always supersedes the
// previous mark, even when the new target isn't itself ringed (a category), so an old command's ring doesn't linger.
// The mark is exclusive and persists until the next navigation. index.css styles [data-anchor-highlight] (a ring plus
// a flash on apply) for the settings page; reused verbatim here so a link lands the same way in both places.
function setAnchorHighlight(el: HTMLElement, mark: boolean) {
	for (const other of document.querySelectorAll('[data-anchor-highlight]')) {
		if (other !== el) other.removeAttribute('data-anchor-highlight')
	}
	if (mark) el.setAttribute('data-anchor-highlight', 'true')
	else el.removeAttribute('data-anchor-highlight')
}

// A link to a fragment on the page, mirroring the settings page's AnchorLink: a real href (so it can be copied or
// opened in a new tab) that on plain click scrolls/records in-place rather than letting the browser jump. Revealed on
// hover of its row, which must carry `group`.
function AnchorLinkIcon({ id, onNavigate, label }: { id: string; onNavigate: (id: string) => void; label: string }) {
	return (
		<a
			href={`#${encodeURIComponent(id)}`}
			className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
			title={label}
			aria-label={label}
			onClick={(e) => {
				e.preventDefault()
				onNavigate(id)
			}}
		>
			<Icons.Link className="h-3.5 w-3.5" />
		</a>
	)
}

// the full listing a compact card's "Details" jumps to: a command under its own declared section, an alias under
// Aliases. The Pinned / Quick Reference cards are shortcuts, so Details links to the real entry rather than repeating
// its arguments and examples inline.
function detailsAnchorId(entry: Entry): string {
	return entry.kind === 'command'
		? `section:${CMD.COMMAND_DECLARATIONS[entry.cmdId].section}/command:${entry.cmdId}`
		: `${ALIASES_SECTION_ID}/alias:${entry.alias.alias}`
}

// A command or alias reduced to its first string, its one-line description, and a link to the full listing. Small
// enough to pack many per row -- the Pinned and Quick Reference sections are for scanning what exists, not reading the
// detail. Not itself a scroll target: it lives above the scrolling body, and Details is what jumps into the body.
// `onUnpin` is set for the pinned cards (which are always commands), adding an unpin control at the bottom-left.
function CompactEntry({ entry, onDetails, onUnpin }: { entry: Entry; onDetails: (id: string) => void; onUnpin?: () => void }) {
	const string = entry.kind === 'command' ? entry.cmd.strings[0] ?? entry.cmdId : entry.alias.alias
	const description = entry.kind === 'command'
		? Messages.GENERAL.command.descriptions[entry.cmdId]
		: Messages.GENERAL.command.aliasDescription(entry.alias.command)
	return (
		<div className="flex h-full flex-col gap-1 rounded-md border bg-background px-2.5 py-1.5">
			<div className="flex items-center justify-between gap-1">
				<code className="truncate font-mono text-sm font-medium" title={string}>{string}</code>
				<Button
					variant="ghost"
					size="sm"
					className="h-5 shrink-0 gap-0.5 px-1 text-xs text-muted-foreground"
					onClick={() => onDetails(detailsAnchorId(entry))}
				>
					Details <Icons.ArrowRight className="h-3 w-3" />
				</Button>
			</div>
			<p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>
			{onUnpin && (
				// mt-auto keeps it on the card's bottom edge even when a shorter description leaves the card taller than its
				// content (grid rows stretch every card to the tallest in the row)
				<Button
					variant="ghost"
					size="sm"
					className="mt-auto h-5 shrink-0 gap-0.5 self-end px-1 text-xs text-muted-foreground hover:text-foreground"
					onClick={onUnpin}
				>
					<Icons.PinOff className="h-3 w-3" /> Unpin
				</Button>
			)}
		</div>
	)
}

function CompactGrid(
	{ entries, onDetails, onUnpin }: { entries: Entry[]; onDetails: (id: string) => void; onUnpin?: (cmdId: CMD.CommandId) => void },
) {
	return (
		<div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]">
			{entries.map((entry) => (
				<CompactEntry
					key={entry.id}
					entry={entry}
					onDetails={onDetails}
					onUnpin={onUnpin && entry.kind === 'command' ? () => onUnpin(entry.cmdId) : undefined}
				/>
			))}
		</div>
	)
}

// A titled block of compact cards on a secondary background: the "Your Pinned Commands" and "Quick Reference"
// scans that sit above the menu. Both are shortcuts into the sections below, so their cards' Details link jumps there.
function CompactSection(
	{ title, section, onDetails, onUnpin }: {
		title: string
		section: Section
		onDetails: (id: string) => void
		onUnpin?: (cmdId: CMD.CommandId) => void
	},
) {
	return (
		<section className="rounded-lg bg-secondary/60 p-4">
			<h2 className="mb-3 text-base font-semibold tracking-tight">{title}</h2>
			<CompactGrid entries={section.entries} onDetails={onDetails} onUnpin={onUnpin} />
		</section>
	)
}

// tracks which entry the body is scrolled to, so the matching TOC row can be highlighted
function useActiveEntry(scrollRef: React.RefObject<HTMLDivElement | null>, deps: unknown): string | null {
	const [activeId, setActiveId] = React.useState<string | null>(null)
	React.useEffect(() => {
		const container = scrollRef.current
		if (!container) return
		let raf = 0
		const compute = () => {
			raf = 0
			const anchors = container.querySelectorAll<HTMLElement>('[data-cmd-anchor]')
			// Once the list has bottomed out nothing scrolls any further, so the last entries never reach the fold and
			// would never highlight however far you scroll. The end of the scroll belongs to the last entry.
			if (anchors.length > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
				setActiveId(anchors[anchors.length - 1].id)
				return
			}
			// The entry crossing the middle of the body wins. That's also where scrollToEntry lands a target, so the
			// highlight doesn't move when the keyboard cursor is dropped and this takes back over.
			const fold = container.getBoundingClientRect().top + container.clientHeight / 2
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
	const pinnedSet = new Set(pinned)
	if (pinned.length > 0) {
		sections.push({
			id: PINNED_SECTION_ID,
			label: 'Pinned',
			entries: pinned.map((cmdId) => commandEntry(PINNED_SECTION_ID, cmdId, settings.commands[cmdId], 'Pinned')),
		})
	}

	// a pinned command is already called out in the Pinned subsection above, so it drops out of the quick-reference grid
	const quickRef = CMD.COMMAND_IDS.filter((id) => settings.commands[id].quickReference && !pinnedSet.has(id))
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
	// the whole page is one scroll container; the header, quick reference, table of contents and listings scroll
	// together within it, and the table of contents sticks once it reaches the top
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const navRef = React.useRef<HTMLElement>(null)
	const searchRef = React.useRef<HTMLInputElement>(null)
	// set while scrollToEntry runs, so the page's own scrolling isn't mistaken for the user taking over
	const scrollingToEntry = React.useRef(false)
	const stickyZIndex = useZIndex(ZI_OFFSETS.STICKYGROUP_FLOOR)
	// latched: read once on mount, consumed by the effect below, so a later hash rewrite can't re-trigger it
	const pendingAnchor = React.useRef<string | null>(currentAnchor())

	// Puts an entry in the middle of the body -- so it arrives with its neighbours for context, rather than tucked under
	// the sticky section header. Instant, never smooth: a smooth scroll is still travelling when the next keypress or
	// click lands, so the cursor ends up scheduling scrolls faster than they finish. Returns false for an id that isn't
	// on the page (a stale link), leaving the body where it was.
	const landOnEntry = React.useCallback((id: string, opts?: { highlight?: boolean; scroll?: boolean }) => {
		const el = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
		if (!el) return false
		// a link icon on an entry the user is already looking at rings and records it without scrolling (opts.scroll false)
		if (opts?.scroll !== false) {
			scrollingToEntry.current = true
			el.scrollIntoView({ block: 'center', behavior: 'instant' })
			requestAnimationFrame(() => {
				scrollingToEntry.current = false
			})
		}
		setAnchorHighlight(el, opts?.highlight ?? false)
		return true
	}, [])

	// focus the search box on arrival, as the settings page does -- unless a fragment is taking the user somewhere
	// specific, where stealing focus would fight the landing
	React.useEffect(() => {
		if (!settings || currentAnchor()) return
		searchRef.current?.focus({ preventScroll: true })
	}, [settings])

	// a fragment on arrival (someone followed a link) lands on it once the list has rendered. A category anchor has no
	// `/`; it scrolls but isn't ringed or given the cursor, matching an in-page category-link click.
	React.useEffect(() => {
		const id = pendingAnchor.current
		if (!settings || !id) return
		pendingAnchor.current = null
		const isEntry = id.includes('/')
		if (landOnEntry(id, { highlight: true }) && isEntry) setCursorId(id)
	}, [settings, landOnEntry])

	// A hash pasted or edited on a page that's already open. In-app navigation uses replaceState, which fires no
	// hashchange, so a TOC click doesn't come back through here and land twice.
	React.useEffect(() => {
		const onHash = () => {
			const id = currentAnchor()
			if (!id) return
			const isEntry = id.includes('/')
			if (landOnEntry(id, { highlight: true }) && isEntry) setCursorId(id)
		}
		window.addEventListener('hashchange', onHash)
		return () => window.removeEventListener('hashchange', onHash)
	}, [landOnEntry])

	const sections = React.useMemo(() => settings ? buildSections(settings, pinnedCommands) : [], [settings, pinnedCommands])
	const pinnedSet = React.useMemo(() => new Set(pinnedCommands), [pinnedCommands])

	// Pinned and Quick Reference render as one block above the menu, never as body sections or table-of-contents rows --
	// they're a scan of the everyday commands, and the body below is the full menu.
	const pinnedShortcut = sections.find((s) => s.id === PINNED_SECTION_ID)
	const quickRefShortcut = sections.find((s) => s.id === QUICK_REF_SECTION_ID)
	// the body always lists every section; the search narrows only the table of contents
	const contentSections = sections.filter((s) => !SHORTCUT_SECTION_IDS.has(s.id))

	const q = query.trim().toLowerCase()
	// a section-label match keeps the whole section, so searching "moderation" lists everything under it
	const tocSections = q
		? contentSections
			.map((s) => (s.label.toLowerCase().includes(q) ? s : { ...s, entries: s.entries.filter((e) => e.search.includes(q)) }))
			.filter((s) => s.entries.length > 0)
		: contentSections
	const tocEntryIds = tocSections.flatMap((s) => s.entries.map((e) => e.id))

	const activeId = useActiveEntry(scrollRef, contentSections.map((s) => s.id).join(','))
	// the table of contents highlights the entry the keyboard is on -- the one Enter jumps to -- or the first match
	// while searching; with neither, it follows the section the page is scrolled to
	const focusId = cursorId ?? (q ? tocEntryIds[0] ?? null : null)
	const tocHighlightId = focusId ?? activeId

	if (!settings) return null

	// Records the target in the URL, scrolls to it (unless scroll:false) and rings it, as the settings page does for
	// both fields and sections. Only a command/alias (its id carries a `/`) also takes the table-of-contents cursor:
	// that cursor drives the command highlight in the list, and a whole section isn't one of those rows.
	function navigateToEntry(id: string, opts?: { scroll?: boolean }) {
		const scroll = opts?.scroll !== false
		// replaceState keeps the history stack clean and skips the browser's own jump; a no-op when the hash matches
		history.replaceState(history.state, '', `#${encodeURIComponent(id)}`)
		if (id.includes('/')) setCursorId(id)
		landOnEntry(id, { highlight: true, scroll })
	}

	// what a link icon on an entry does: exactly what its table-of-contents row does (record the URL, ring it, put the
	// cursor on it), minus the scroll -- the user is already looking at the entry the icon sits on
	const linkToEntry = (id: string) => navigateToEntry(id, { scroll: false })

	// The search box drives the table of contents, not the page: up/down move the focused row, Enter jumps to it. Enter
	// with nothing arrowed jumps to the first match. Arrowing only moves the focus (and keeps that row in view within
	// the list); it doesn't scroll the page -- that's what Enter is for.
	function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === 'Enter') {
			const target = focusId ?? tocEntryIds[0]
			if (target) {
				e.preventDefault()
				navigateToEntry(target)
			}
			return
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		if (tocEntryIds.length === 0) return
		// otherwise the caret jumps to either end of the query
		e.preventDefault()
		const delta = e.key === 'ArrowDown' ? 1 : -1
		const from = tocEntryIds.indexOf(focusId ?? '')
		const next = from === -1
			? (delta === 1 ? 0 : tocEntryIds.length - 1)
			: Math.min(Math.max(from + delta, 0), tocEntryIds.length - 1)
		const nextId = tocEntryIds[next]
		setCursorId(nextId)
		navRef.current?.querySelector(`[data-toc-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: 'nearest' })
	}

	return (
		// One scroll container for the whole page. The height is pinned as the settings page does: _app only bounds its
		// own height on the dashboard route, so flex-1/min-h-0 alone would leave this growing to fit its content and the
		// window scrolling instead. 6rem = the nav bar + _app's padding.
		<div
			ref={scrollRef}
			className="h-[calc(100dvh-6rem)] w-full overflow-y-auto"
			onScroll={() => {
				if (!scrollingToEntry.current) setCursorId(null)
			}}
		>
			<div className="mx-auto w-full max-w-6xl px-1">
				<header className="pt-1 pb-3">
					<h1 className="text-xl font-semibold">Ingame Commands</h1>
					<p className="pt-1 text-sm text-muted-foreground">
						Everything you type is case-insensitive. Player, squad and flag names match on any part of the name, ignoring spaces.
					</p>
				</header>
				{(pinnedShortcut || quickRefShortcut) && (
					<div className="space-y-4 pb-6">
						{pinnedShortcut && (
							<CompactSection
								title="Your Pinned Commands"
								section={pinnedShortcut}
								onDetails={navigateToEntry}
								onUnpin={ClientOnlySettings.Actions.toggleCommandPinned}
							/>
						)}
						{quickRefShortcut && <CompactSection title="Quick Reference" section={quickRefShortcut} onDetails={navigateToEntry} />}
					</div>
				)}
				<div className="flex gap-4">
					{
						/* the table of contents is the one thing that stays put: it sticks once the header and quick reference
					    have scrolled off, capped to the viewport with its own scroll for a long list. bg so the everyday
					    commands pass behind it as they scroll away. */
					}
					<aside
						style={{ zIndex: stickyZIndex }}
						className="sticky top-0 flex max-h-[calc(100dvh-6rem)] w-52 shrink-0 flex-col self-start border-r bg-background pr-2"
					>
						<div className="relative shrink-0 bg-background pt-2 pb-2">
							<Icons.Search className="absolute left-2 top-[1.15rem] -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<Input
								ref={searchRef}
								className="h-8 pl-7"
								placeholder="Search commands…"
								onChange={(e) => {
									setQuery(e.target.value)
									setCursorId(null)
								}}
								onKeyDown={onSearchKeyDown}
							/>
						</div>
						<nav ref={navRef} className="min-h-0 flex-1 overflow-y-auto">
							{tocSections.length === 0
								? <p className="px-1 text-sm text-muted-foreground">No matches.</p>
								: (
									<ul>
										{tocSections.map((section) => (
											<li key={section.id} className="pt-4 first:pt-0">
												<button
													type="button"
													onClick={() => navigateToEntry(section.id)}
													className="block w-full border-b border-border px-1 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-foreground hover:text-foreground/70"
												>
													{section.label}
												</button>
												<ul className="space-y-px pl-2 pt-1">
													{section.entries.map((entry) => (
														<li key={entry.id}>
															<button
																type="button"
																data-toc-id={entry.id}
																onClick={() => navigateToEntry(entry.id)}
																className={cn(
																	'block w-full truncate rounded px-1 py-0.5 text-left font-mono text-sm hover:text-foreground',
																	entry.id === tocHighlightId ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
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
					<div className="min-w-0 flex-1">
						{contentSections.map((section) => (
							<section key={section.id} className="pb-8 last:pb-2">
								<h2
									id={section.id}
									style={{ zIndex: stickyZIndex }}
									className="group sticky top-0 mb-2 flex scroll-mt-1 items-center gap-2 border-b-2 border-border bg-background pb-1.5 pt-1 text-base font-semibold tracking-tight"
								>
									{section.label}
									<AnchorLinkIcon
										id={section.id}
										onNavigate={(id) => navigateToEntry(id, { scroll: false })}
										label={`Link to ${section.label}`}
									/>
								</h2>
								{section.blurb && <p className="pb-3 text-sm text-muted-foreground">{section.blurb}</p>}
								{/* dividers between commands: the arg signatures wrap, which left the boundary between two ambiguous on spacing alone */}
								<div className="divide-y divide-border/70">
									{section.entries.map((entry) => (
										<div key={entry.id} className="py-3 first:pt-0 last:pb-0">
											{entry.kind === 'command'
												? <CommandEntry entry={entry} settings={settings} pinned={pinnedSet.has(entry.cmdId)} onLink={linkToEntry} />
												: <AliasEntry entry={entry} settings={settings} onLink={linkToEntry} />}
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
