import { Button } from '@/components/ui/button'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import * as SettingsEditorFrame from '@/frames/settings-editor.frame'
import type { SettingChange } from '@/lib/settings-diff'
import { formatChangeValue } from '@/lib/settings-diff'
import * as SettingsNav from '@/lib/settings-nav'
import * as ZusUtils from '@/lib/zustand'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as Icons from 'lucide-react'
import React from 'react'

// A single Save/Reset control panel shared by every editable settings section (global settings + each server + the
// new-server form). Sections are settings-editor frame instances; the panel derives everything it shows straight from
// their stores, and commits every dirty GUI-mode section on Save (JSON mode keeps its own inline toolbar).

// secrets (rcon/sftp passwords, server-agent token) must not be shown in plain text in the save confirmation. Redact by
// key name so it also covers object-level diffs (e.g. the whole `connections` object added when creating a server).
const SENSITIVE_KEYS = new Set(['password', 'token', 'secret'])
const MASK = '••••••••'

function redactValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(redactValue)
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, val] of Object.entries(v)) {
			out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) && typeof val === 'string' && val !== '' ? MASK : redactValue(val)
		}
		return out
	}
	return v
}

// display a change value with secrets masked: a scalar under a sensitive leaf key, plus any sensitive keys nested inside
// an object/array value
function displaySettingValue(path: string, v: unknown): string {
	const leaf = path.split('.').pop() ?? ''
	if (SENSITIVE_KEYS.has(leaf.toLowerCase()) && typeof v === 'string' && v !== '') return MASK
	return formatChangeValue(redactValue(v))
}

export function SettingsChangeList({ changes }: { changes: SettingChange[] }) {
	return (
		<div className="max-h-[50vh] space-y-2 overflow-y-auto text-sm">
			{changes.map((c) => (
				<div key={c.path} className="border-b pb-1.5 last:border-0">
					<code className="text-xs text-muted-foreground">{c.path}</code>
					<div className="mt-0.5 flex flex-wrap items-center gap-2">
						<span className="text-muted-foreground line-through break-all">{displaySettingValue(c.path, c.from)}</span>
						<Icons.ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
						<span className="break-all">{displaySettingValue(c.path, c.to)}</span>
					</div>
				</div>
			))}
		</div>
	)
}

// what the panel needs to know about one section, derived per render from its frame state
type SectionView = {
	key: SettingsEditorFrame.Key
	state: SettingsEditorFrame.SettingsEditor
	label: string
	// only GUI-mode sections route through the panel; JSON mode saves inline
	changedCount: number
	deniedIds: string[]
}

export function SettingsSavePanel({ sectionKeys }: { sectionKeys: SettingsEditorFrame.Key[] }) {
	const openDialog = useAlertDialog()
	const zIndex = useZIndex(ZI_OFFSETS.STICKYGROUP_CEILING)
	const states = SettingsEditorFrame.useSectionStates(sectionKeys)
	const perms = RbacClient.useLoggedInPerms()
	const servers = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)

	const sections: SectionView[] = React.useMemo(() => {
		const nameById = new Map((servers ?? []).map((s) => [s.id, s.displayName]))
		return sectionKeys.map((key, i): SectionView => {
			const state = states[i]
			const gui = state.mode === 'gui'
			const label = state.kind === 'global'
				? 'Global Settings'
				: state.kind === 'server'
				? nameById.get(state.serverId!) ?? state.serverId!
				: state.newDisplayName.trim() || 'New Server'
			// a new-server section always counts as one pending change while open; once created it no longer participates
			const changedCount = !gui ? 0 : state.kind === 'new-server' ? (state.created ? 0 : 1) : state.changes.length
			const deniedIds = gui
				? SettingsEditorFrame.deniedSettingPaths(state, perms).map((p) => `${SettingsEditorFrame.Sel.idPrefix(state)}${p}`)
				: []
			return { key, state, label, changedCount, deniedIds }
		})
	}, [sectionKeys, states, perms, servers])

	let totalChanges = 0
	let totalErrors = 0
	let totalDenied = 0
	let anyInvalid = false
	let anySaving = false
	for (const s of sections) {
		totalErrors += s.state.issues.length
		if (s.changedCount === 0) continue
		totalChanges += s.changedCount
		totalDenied += s.deniedIds.length
		if (!s.state.valid) anyInvalid = true
		if (s.state.saving) anySaving = true
	}

	// cycles through the fields currently flagged with a validation error (document order); each step navigates the
	// anchor so the target scrolls into view and picks up the fragment highlight
	const errIdx = React.useRef(-1)
	function navigateErrors(dir: 1 | -1) {
		const els = Array.from(document.querySelectorAll<HTMLElement>('main [data-settings-error]'))
		if (els.length === 0) return
		errIdx.current = (errIdx.current + dir + els.length) % els.length
		const el = els[errIdx.current]
		if (el.id) SettingsNav.navigateToAnchor(el.id)
	}

	// cycles through the fields whose pending changes fall outside the user's write grant. A denied change path is a
	// diff leaf, which can sit below the field that renders it (e.g. inside an override widget), so walk up the dotted
	// path until an anchored element exists.
	const deniedIdx = React.useRef(-1)
	function navigateDenied(dir: 1 | -1) {
		const ids = sections.flatMap((s) => s.deniedIds)
		if (ids.length === 0) return
		deniedIdx.current = (deniedIdx.current + dir + ids.length) % ids.length
		let cur = ids[deniedIdx.current]
		while (!document.getElementById(cur)) {
			const i = cur.lastIndexOf('.')
			if (i === -1) return
			cur = cur.slice(0, i)
		}
		SettingsNav.navigateToAnchor(cur)
	}

	async function handleSave() {
		const dirty = sections.filter((s) => s.changedCount > 0)
		if (dirty.length === 0 || dirty.some((s) => !s.state.valid || s.deniedIds.length > 0)) return
		const result = await openDialog({
			title: 'Save settings?',
			content: (
				<div className="space-y-4">
					{dirty.map((s) => (
						<div key={SettingsEditorFrame.Sel.idPrefix(s.state)}>
							{dirty.length > 1 && <p className="mb-1 text-sm font-semibold">{s.label}</p>}
							<SettingsChangeList changes={s.state.changes} />
						</div>
					))}
				</div>
			),
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') {
			await Promise.all(dirty.map((s) => SettingsEditorFrame.Actions.save({ settingsEditor: s.key })))
		}
	}

	function handleReset() {
		for (const s of sections) {
			if (s.changedCount > 0) SettingsEditorFrame.Actions.resetDraft({ settingsEditor: s.key })
		}
	}

	// the panel must stay reachable while multiple errors need chasing down, even with nothing to save yet
	if (totalChanges === 0 && totalErrors <= 1) return null

	return (
		<div
			style={{ zIndex }}
			className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
		>
			{totalErrors > 0 && (
				<span className="flex items-center gap-0.5 text-sm font-medium text-destructive">
					<Icons.CircleAlert className="mr-1 h-4 w-4" />
					{totalErrors} {totalErrors === 1 ? 'error' : 'errors'}
					<Button
						variant="ghost"
						size="icon"
						className="ml-1 h-6 w-6 text-destructive"
						title="Previous error"
						onClick={() => navigateErrors(-1)}
					>
						<Icons.ChevronUp className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 text-destructive"
						title="Next error"
						onClick={() => navigateErrors(1)}
					>
						<Icons.ChevronDown className="h-4 w-4" />
					</Button>
				</span>
			)}
			{totalDenied > 0 && (
				<span
					className="flex items-center gap-0.5 text-sm font-medium text-amber-500"
					title="These changes are outside the settings you're allowed to modify"
				>
					<Icons.ShieldAlert className="mr-1 h-4 w-4" />
					{totalDenied} not permitted
					<Button
						variant="ghost"
						size="icon"
						className="ml-1 h-6 w-6 text-amber-500"
						title="Previous denied change"
						onClick={() => navigateDenied(-1)}
					>
						<Icons.ChevronUp className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 text-amber-500"
						title="Next denied change"
						onClick={() => navigateDenied(1)}
					>
						<Icons.ChevronDown className="h-4 w-4" />
					</Button>
				</span>
			)}
			<span className="text-sm">
				<span className="font-medium">{totalChanges}</span> {totalChanges === 1 ? 'setting' : 'settings'} changed
			</span>
			<Button variant="outline" size="sm" onClick={handleReset}>Reset</Button>
			<Button size="sm" disabled={anyInvalid || anySaving || totalDenied > 0} onClick={handleSave}>
				{anySaving ? 'Saving…' : 'Save'}
			</Button>
		</div>
	)
}
