import { StickyGroup } from '@/components/sticky-group'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SettingsGroup } from '@/lib/settings-groups'
import { GLOBAL_SETTINGS_GROUPS, GLOBAL_SETTINGS_PRIORITY_KEYS, HIDDEN_GLOBAL_SETTINGS_KEYS, splitByGroups, TOC_LEAF_PATHS } from '@/lib/settings-groups'
import { settingLabel } from '@/lib/settings-labels'
import * as SettingsNav from '@/lib/settings-nav'
import { cn } from '@/lib/utils'
import * as SETTINGS from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { z } from 'zod'

// A tree-of-contents for the settings page. Nodes mirror the global-settings schema tree; clicking one scrolls the
// matching field (anchored by `setting:<path>` ids emitted by SettingsForm) into view within the main scroll column.

type Node = any
// `writable`: the user's write grant overlaps this node's subtree. Rendered as a pencil marker (only when some
// restriction exists on the page), so a path-restricted user can drill down to their editable settings even from a
// fully collapsed tree.
type TocNode = { id: string; label: string; path: string; writable: boolean; children: TocNode[] }

const WRITE_ALL: RBAC.SettingsWriteAccess = { kind: 'all' }
const WRITE_NONE: RBAC.SettingsWriteAccess = { kind: 'none' }

function stripNullable(node: Node): Node {
	if (node?.anyOf) {
		const others = node.anyOf.filter((b: Node) => b.type !== 'null')
		if (others.length === 1) return others[0]
	}
	return node
}

// idPrefix scopes anchor ids so per-server subtrees (`setting:server:<id>:*`) don't collide with global (`setting:*`);
// it must match what SettingsForm emits for the same schema.
function buildChildren(node: Node, path: (string | number)[], idPrefix: string, access: RBAC.SettingsWriteAccess): TocNode[] {
	const props: Record<string, Node> | undefined = node?.properties
	if (!props) return []
	// top-level keys managed inline by a sibling editor (e.g. defaultPrefix) render no field, so emit no TOC anchor either
	return Object.keys(props).filter((key) => !(path.length === 0 && HIDDEN_GLOBAL_SETTINGS_KEYS.has(key))).map((key): TocNode => {
		const inner = stripNullable(props[key])
		const childPath = [...path, key]
		const pathStr = childPath.join('.')
		// only static object sections recurse; records/arrays are dynamic, and override-rendered sections
		// (TOC_LEAF_PATHS) emit no per-property anchors, so both stay leaf nodes
		const recurse = inner.type === 'object' && inner.properties && !TOC_LEAF_PATHS.has(pathStr)
		return {
			id: `${idPrefix}${pathStr}`,
			label: settingLabel(childPath, key),
			path: pathStr,
			writable: RBAC.settingsPathOverlaps(access, childPath),
			children: recurse ? buildChildren(inner, childPath, idPrefix, access) : [],
		}
	})
}

// mirror the form's presentation-level grouping: wrap the top-level nodes into group nodes (anchored to the group
// headers the form emits), with the leading keys above them and any ungrouped key at the top level after them
function groupTocNodes(children: TocNode[], groups: SettingsGroup[], idPrefix: string, priorityKeys: string[]): TocNode[] {
	const byKey = new Map(children.map((c) => [c.path, c]))
	const { leading, groups: grouped, ungrouped } = splitByGroups(children.map((c) => c.path), groups, priorityKeys)
	return [
		...leading.map((k) => byKey.get(k)!),
		...grouped.map(({ group, keys }): TocNode => {
			const children = keys.map((k) => byKey.get(k)!)
			return {
				id: `${idPrefix}group:${group.slug}`,
				label: group.label,
				path: `group:${group.slug}`,
				writable: children.some((c) => c.writable),
				children,
			}
		}),
		...ungrouped.map((k) => byKey.get(k)!),
	]
}

function filterNode(node: TocNode, query: string): TocNode | null {
	const children = node.children.map((c) => filterNode(c, query)).filter((c): c is TocNode => c !== null)
	// match on the humanized label or the json path so users can search either
	const selfMatch = node.label.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
	if (selfMatch || children.length > 0) return { ...node, children }
	return null
}

function TocItem(
	{ node, depth, expanded, toggle, forceOpen, activeId, showMarkers }: {
		node: TocNode
		depth: number
		expanded: Set<string>
		toggle: (id: string) => void
		forceOpen: boolean
		activeId: string | null
		showMarkers: boolean
	},
) {
	const hasChildren = node.children.length > 0
	const isOpen = forceOpen || expanded.has(node.id)
	const isActive = node.id === activeId
	// parent rows pin (and stack under their own ancestors) while their children scroll past; leaf rows never pin
	const headerRef = React.useRef<HTMLDivElement>(null)
	const header = (
		<div
			ref={headerRef}
			className={cn('flex items-center gap-0.5', hasChildren && 'bg-background')}
			style={{ paddingLeft: depth * 12 }}
		>
			{hasChildren
				? (
					<button
						type="button"
						className="p-0.5 text-muted-foreground hover:text-foreground shrink-0"
						onClick={() => toggle(node.id)}
						aria-label={isOpen ? 'Collapse' : 'Expand'}
					>
						<Icons.ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
					</button>
				)
				: <span className="w-[18px] shrink-0" />}
			<a
				href={`#${node.id}`}
				className={cn(
					'block truncate text-left text-sm py-0.5 px-1 rounded flex-1 min-w-0 hover:text-foreground',
					isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
				)}
				title={node.label}
				onClick={(e) => {
					e.preventDefault()
					SettingsNav.navigateToAnchor(node.id)
				}}
			>
				{node.label}
			</a>
			{showMarkers && node.writable && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.Pencil className="mr-1 h-3 w-3 shrink-0 text-muted-foreground" />
					</TooltipTrigger>
					<TooltipContent>Contains settings you can modify</TooltipContent>
				</Tooltip>
			)}
		</div>
	)
	const children = isOpen && hasChildren && (
		<ul>
			{node.children.map((c) => (
				<TocItem
					key={c.id}
					node={c}
					depth={depth + 1}
					expanded={expanded}
					toggle={toggle}
					forceOpen={forceOpen}
					activeId={activeId}
					showMarkers={showMarkers}
				/>
			))}
		</ul>
	)
	return (
		<li data-toc-id={node.id}>
			{hasChildren
				? (
					<StickyGroup stickyRef={headerRef}>
						{header}
						{children}
					</StickyGroup>
				)
				: header}
		</li>
	)
}

// tracks which anchored field/section is currently at the top of the main scroll column
function useActiveAnchor(deps: unknown): string | null {
	const [activeId, setActiveId] = React.useState<string | null>(null)
	React.useEffect(() => {
		const main = document.querySelector('main')
		if (!main) return
		let raf = 0
		const compute = () => {
			raf = 0
			const mainTop = main.getBoundingClientRect().top
			// push the fold line below any currently-pinned sticky headers, so the section visible beneath the pinned
			// stack wins (a header is "pinned" when its top has reached its sticky offset)
			let fold = mainTop + 12
			for (const s of main.querySelectorAll<HTMLElement>('[style*="position: sticky"]')) {
				const offset = parseFloat(getComputedStyle(s).top) || 0
				const r = s.getBoundingClientRect()
				if (Math.abs(r.top - (mainTop + offset)) < 2) fold = Math.max(fold, r.bottom)
			}
			const anchors = main.querySelectorAll<HTMLElement>('[id^="setting:"],[id^="section:"]')
			let current: string | null = null
			// anchors are in document order (top-to-bottom); the last one above the fold is the active one. the tolerance
			// covers the small breathing gap scrollToId leaves between a navigated target and the pinned stack above it.
			for (const el of anchors) {
				if (el.getBoundingClientRect().top <= fold + 12) current = el.id
			}
			if (!current && anchors.length > 0) current = anchors[0].id
			setActiveId(current)
		}
		const onScroll = () => {
			if (raf === 0) raf = requestAnimationFrame(compute)
		}
		main.addEventListener('scroll', onScroll, { passive: true })
		compute()
		return () => {
			main.removeEventListener('scroll', onScroll)
			if (raf !== 0) cancelAnimationFrame(raf)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deps])
	return activeId
}

function buildParentMap(nodes: TocNode[], parentId: string | null, map: Map<string, string | null>) {
	for (const node of nodes) {
		map.set(node.id, parentId)
		buildParentMap(node.children, node.id, map)
	}
}

export default function SettingsToc(
	{ showServers, showGlobal, globalMode, servers, serverModes, creatingServer, newServerMode }: {
		showServers: boolean
		showGlobal: boolean
		globalMode: 'gui' | 'json'
		servers: { id: string; displayName: string }[]
		serverModes: Record<string, 'gui' | 'json'>
		creatingServer: boolean
		newServerMode: 'gui' | 'json'
	},
) {
	const [query, setQuery] = React.useState('')
	const [expanded, setExpanded] = React.useState<Set<string>>(new Set(['section:servers', 'section:global']))
	const containerRef = React.useRef<HTMLDivElement>(null)
	const searchRef = React.useRef<HTMLInputElement>(null)

	// an anchored visit is already taking the user somewhere specific (and the settle-scroll would fight the focus), so
	// only claim focus when the page opens with no fragment. preventScroll: the input sits in its own scroll column.
	React.useEffect(() => {
		if (SettingsNav.currentAnchor()) return
		searchRef.current?.focus({ preventScroll: true })
	}, [])

	const perms = RbacClient.useLoggedInPerms()
	const globalWrite = React.useMemo(() => RBAC.globalSettingsWriteAccess(perms), [perms])
	// same widening as the settings form: write-sensitive permits connections edits independent of any general write grant
	const serverWriteById = React.useMemo(() => {
		const map = new Map<string, RBAC.SettingsWriteAccess>()
		for (const s of servers) {
			let write = RBAC.serverSettingsWriteAccess(perms, s.id)
			if (write.kind !== 'all' && RBAC.canWriteSensitiveServerSettings(perms, s.id)) {
				const paths = write.kind === 'paths' ? write.paths : []
				write = { kind: 'paths', paths: [...paths, 'connections'] }
			}
			map.set(s.id, write)
		}
		return map
	}, [perms, servers])

	// the field anchors only exist in the GUI editor; in JSON mode a section collapses to a single leaf
	const globalChildren = React.useMemo(
		() =>
			globalMode === 'json'
				? []
				: groupTocNodes(
					buildChildren(
						z.toJSONSchema(SETTINGS.GlobalSettingsSchema, { io: 'input', unrepresentable: 'any' }) as Node,
						[],
						'setting:',
						globalWrite,
					),
					GLOBAL_SETTINGS_GROUPS,
					'setting:',
					GLOBAL_SETTINGS_PRIORITY_KEYS,
				),
		[globalMode, globalWrite],
	)

	const serverJsonSchema = React.useMemo(
		() => z.toJSONSchema(SETTINGS.ServerSettingsSchema, { io: 'input', unrepresentable: 'any' }) as Node,
		[],
	)

	const serverNodes = React.useMemo(() => {
		const nodes: TocNode[] = servers.map((s) => {
			const write = serverWriteById.get(s.id) ?? WRITE_NONE
			return {
				id: `section:server:${s.id}`,
				label: s.displayName,
				path: '',
				writable: write.kind !== 'none',
				children: (serverModes[s.id] ?? 'gui') === 'json' ? [] : buildChildren(serverJsonSchema, [], `setting:server:${s.id}:`, write),
			}
		})
		if (creatingServer) {
			nodes.push({
				id: 'section:server:__new__',
				label: 'New Server',
				path: '',
				writable: true,
				children: newServerMode === 'json' ? [] : buildChildren(serverJsonSchema, [], 'setting:server:__new__:', WRITE_ALL),
			})
		}
		return nodes
	}, [servers, serverModes, creatingServer, newServerMode, serverJsonSchema, serverWriteById])

	const nodes = React.useMemo(() => {
		const roots: TocNode[] = []
		if (showServers) {
			roots.push({
				id: 'section:servers',
				label: 'Servers',
				path: '',
				writable: serverNodes.some((n) => n.writable),
				children: serverNodes,
			})
		}
		if (showGlobal) {
			roots.push({
				id: 'section:global',
				label: 'Global Settings',
				path: '',
				writable: globalWrite.kind !== 'none',
				children: globalChildren,
			})
			roots.push({ id: 'section:audit', label: 'Audit Log', path: '', writable: false, children: [] })
		}
		return roots
	}, [showServers, showGlobal, globalChildren, serverNodes, globalWrite])

	// markers only add signal when something on the page is write-restricted; a fully-unrestricted admin sees none
	const showMarkers = (showGlobal && globalWrite.kind !== 'all')
		|| servers.some((s) => (serverWriteById.get(s.id) ?? WRITE_NONE).kind !== 'all')

	const parentById = React.useMemo(() => {
		const map = new Map<string, string | null>()
		buildParentMap(nodes, null, map)
		return map
	}, [nodes])

	const q = query.trim().toLowerCase()
	const forceOpen = q.length > 0
	const visible = q ? nodes.map((n) => filterNode(n, q)).filter((n): n is TocNode => n !== null) : nodes

	// re-run scroll-spy when the anchor set changes (gui/json switch, servers added/removed, per-server mode)
	const anchorSetSig = `${globalMode}|${servers.map((s) => `${s.id}:${serverModes[s.id] ?? 'gui'}`).join(',')}|${
		creatingServer ? newServerMode : ''
	}`
	const activeAnchorId = useActiveAnchor(anchorSetSig)

	// if the active anchor sits inside a collapsed branch, highlight the deepest ancestor that's actually visible
	const activeId = React.useMemo(() => {
		if (!activeAnchorId) return null
		const isVisible = (id: string) => {
			if (forceOpen) return true
			let p = parentById.get(id) ?? null
			while (p) {
				if (!expanded.has(p)) return false
				p = parentById.get(p) ?? null
			}
			return true
		}
		let cur: string | null = activeAnchorId
		while (cur && !isVisible(cur)) cur = parentById.get(cur) ?? null
		return cur
	}, [activeAnchorId, parentById, expanded, forceOpen])

	// keep the highlighted item in view within the (independently scrolling) sidebar
	React.useEffect(() => {
		if (!activeId) return
		const el = containerRef.current?.querySelector(`[data-toc-id="${CSS.escape(activeId)}"]`)
		el?.scrollIntoView({ block: 'nearest' })
	}, [activeId])

	function toggle(id: string) {
		setExpanded((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	return (
		<div ref={containerRef} className="flex flex-col h-full min-h-0">
			{/* search stays fixed above the independently-scrolling tree */}
			<div className="shrink-0 bg-background pb-2">
				<div className="relative">
					<Icons.Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						ref={searchRef}
						className="h-8 pl-7"
						placeholder="Search settings…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
			</div>
			<nav className="flex-1 min-h-0 overflow-y-auto">
				{visible.length === 0
					? <p className="text-sm text-muted-foreground px-1">No matches.</p>
					: (
						<ul>
							{visible.map((n) => (
								<TocItem
									key={n.id}
									node={n}
									depth={0}
									expanded={expanded}
									toggle={toggle}
									forceOpen={forceOpen}
									activeId={activeId}
									showMarkers={showMarkers}
								/>
							))}
						</ul>
					)}
			</nav>
		</div>
	)
}
