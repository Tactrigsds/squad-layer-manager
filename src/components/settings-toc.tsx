import { Input } from '@/components/ui/input'
import { settingLabel } from '@/lib/settings-labels'
import { cn } from '@/lib/utils'
import * as SETTINGS from '@/models/settings.models'
import * as Icons from 'lucide-react'
import React from 'react'
import { z } from 'zod'

// A tree-of-contents for the settings page. Nodes mirror the global-settings schema tree; clicking one scrolls the
// matching field (anchored by `setting:<path>` ids emitted by SettingsForm) into view within the main scroll column.

type Node = any
type TocNode = { id: string; label: string; path: string; children: TocNode[] }

function stripNullable(node: Node): Node {
	if (node?.anyOf) {
		const others = node.anyOf.filter((b: Node) => b.type !== 'null')
		if (others.length === 1) return others[0]
	}
	return node
}

function buildChildren(node: Node, path: (string | number)[]): TocNode[] {
	const props: Record<string, Node> | undefined = node?.properties
	if (!props) return []
	return Object.keys(props).map((key): TocNode => {
		const inner = stripNullable(props[key])
		const childPath = [...path, key]
		return {
			id: `setting:${childPath.join('.')}`,
			label: settingLabel(childPath, key),
			path: childPath.join('.'),
			// only static object sections recurse; records/arrays are dynamic and stay leaf nodes
			children: inner.type === 'object' && inner.properties ? buildChildren(inner, childPath) : [],
		}
	})
}

function filterNode(node: TocNode, query: string): TocNode | null {
	const children = node.children.map((c) => filterNode(c, query)).filter((c): c is TocNode => c !== null)
	// match on the humanized label or the json path so users can search either
	const selfMatch = node.label.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
	if (selfMatch || children.length > 0) return { ...node, children }
	return null
}

function scrollToId(id: string) {
	let el = document.getElementById(id)
	// the target field only exists in the GUI editor; fall back to the global-settings card (e.g. while in JSON mode)
	if (!el && id.startsWith('setting:')) el = document.getElementById('section:global')
	// instant, not smooth: a smooth programmatic scroll across the very tall form gets canceled mid-animation in Chrome
	el?.scrollIntoView({ behavior: 'auto', block: 'start' })
}

function TocItem(
	{ node, depth, expanded, toggle, forceOpen, activeId }: {
		node: TocNode
		depth: number
		expanded: Set<string>
		toggle: (id: string) => void
		forceOpen: boolean
		activeId: string | null
	},
) {
	const hasChildren = node.children.length > 0
	const isOpen = forceOpen || expanded.has(node.id)
	const isActive = node.id === activeId
	return (
		<li data-toc-id={node.id}>
			<div className="flex items-center gap-0.5" style={{ paddingLeft: depth * 12 }}>
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
				<button
					type="button"
					className={cn(
						'truncate text-left text-sm py-0.5 px-1 rounded w-full hover:text-foreground',
						isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
					)}
					title={node.label}
					onClick={() => scrollToId(node.id)}
				>
					{node.label}
				</button>
			</div>
			{isOpen && hasChildren && (
				<ul>
					{node.children.map((c) => (
						<TocItem key={c.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} forceOpen={forceOpen} activeId={activeId} />
					))}
				</ul>
			)}
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
			const anchors = main.querySelectorAll<HTMLElement>('[id^="setting:"],[id^="section:"]')
			const top = main.getBoundingClientRect().top
			let current: string | null = null
			// anchors are in document order (top-to-bottom); the last one above the fold is the active one
			for (const el of anchors) {
				if (el.getBoundingClientRect().top <= top + 12) current = el.id
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
	{ showServers, showGlobal, globalMode }: { showServers: boolean; showGlobal: boolean; globalMode: 'gui' | 'json' },
) {
	const [query, setQuery] = React.useState('')
	const [expanded, setExpanded] = React.useState<Set<string>>(new Set(['section:global']))
	const containerRef = React.useRef<HTMLDivElement>(null)

	// the field anchors only exist in the GUI editor; in JSON mode "Global Settings" collapses to a single leaf
	const globalChildren = React.useMemo(
		() =>
			globalMode === 'json'
				? []
				: buildChildren(z.toJSONSchema(SETTINGS.GlobalSettingsSchema, { io: 'input', unrepresentable: 'any' }) as Node, []),
		[globalMode],
	)

	const nodes = React.useMemo(() => {
		const roots: TocNode[] = []
		if (showServers) roots.push({ id: 'section:servers', label: 'Servers', path: '', children: [] })
		if (showGlobal) {
			roots.push({ id: 'section:global', label: 'Global Settings', path: '', children: globalChildren })
			roots.push({ id: 'section:audit', label: 'Audit Log', path: '', children: [] })
		}
		return roots
	}, [showServers, showGlobal, globalChildren])

	const parentById = React.useMemo(() => {
		const map = new Map<string, string | null>()
		buildParentMap(nodes, null, map)
		return map
	}, [nodes])

	const q = query.trim().toLowerCase()
	const forceOpen = q.length > 0
	const visible = q ? nodes.map((n) => filterNode(n, q)).filter((n): n is TocNode => n !== null) : nodes

	// re-run scroll-spy when the anchor set changes (gui/json switch)
	const activeAnchorId = useActiveAnchor(globalMode)

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
		<div ref={containerRef} className="flex flex-col h-full">
			<div className="sticky top-0 bg-background pb-2 z-10">
				<div className="relative">
					<Icons.Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						className="h-8 pl-7"
						placeholder="Search settings…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
			</div>
			<nav className="min-h-0">
				{visible.length === 0
					? <p className="text-sm text-muted-foreground px-1">No matches.</p>
					: (
						<ul>
							{visible.map((n) => (
								<TocItem key={n.id} node={n} depth={0} expanded={expanded} toggle={toggle} forceOpen={forceOpen} activeId={activeId} />
							))}
						</ul>
					)}
			</nav>
		</div>
	)
}
