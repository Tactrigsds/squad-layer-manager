import { Button } from '@/components/ui/button'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import type { SettingChange } from '@/lib/settings-diff'
import { formatChangeValue } from '@/lib/settings-diff'
import * as SettingsNav from '@/lib/settings-nav'
import * as ZusUtils from '@/lib/zustand'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

// A single Save/Reset control panel shared by every editable settings section (global settings + each server). Each
// section registers a lightweight entry; the panel aggregates their pending changes, commits every dirty section on
// Save (each via its own mutation), and resets them all on Reset. This lets one floating panel serve the whole page
// even when more than one section is dirty at once.

export type SettingsSectionEntry = {
	key: string
	label: string
	// reactive: drive the panel's summary + enabled state
	changedCount: number
	// schema issues in the section's current draft (0 in JSON mode, which validates inline)
	errorCount: number
	valid: boolean
	saving: boolean
	// stable callbacks, read imperatively by the panel (kept out of the reactive selector)
	getChanges: () => SettingChange[]
	save: () => Promise<void>
	reset: () => void
}

export type SettingsEditorState = { sections: Record<string, SettingsSectionEntry> }
export type SettingsEditorStore = Zus.StoreApi<SettingsEditorState>

export function createSettingsEditorStore(): SettingsEditorStore {
	return Zus.createStore<SettingsEditorState>(() => ({ sections: {} }))
}

// register a section into the shared store on mount (keyed by `entry.key`) and keep its reactive fields in sync.
// The registered save/reset/getChanges delegate to the latest `entry` via a ref, so they never go stale.
export function useRegisterSettingsSection(store: SettingsEditorStore, entry: SettingsSectionEntry) {
	const ref = React.useRef(entry)
	ref.current = entry
	const { key, label, changedCount, errorCount, valid, saving } = entry

	React.useEffect(() => {
		store.setState((s) => ({
			sections: {
				...s.sections,
				[key]: {
					key,
					label: ref.current.label,
					changedCount: ref.current.changedCount,
					errorCount: ref.current.errorCount,
					valid: ref.current.valid,
					saving: ref.current.saving,
					getChanges: () => ref.current.getChanges(),
					save: () => ref.current.save(),
					reset: () => ref.current.reset(),
				},
			},
		}))
		return () =>
			store.setState((s) => {
				const next = { ...s.sections }
				delete next[key]
				return { sections: next }
			})
	}, [store, key])

	React.useEffect(() => {
		store.setState((s) => {
			const cur = s.sections[key]
			if (!cur) return s
			if (
				cur.label === label && cur.changedCount === changedCount && cur.errorCount === errorCount && cur.valid === valid
				&& cur.saving === saving
			) return s
			return { sections: { ...s.sections, [key]: { ...cur, label, changedCount, errorCount, valid, saving } } }
		})
	}, [store, key, label, changedCount, errorCount, valid, saving])
}

// secrets (rcon/sftp passwords, log-receiver token) must not be shown in plain text in the save confirmation. Redact by
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

export function SettingsSavePanel({ store }: { store: SettingsEditorStore }) {
	const openDialog = useAlertDialog()
	const zIndex = useZIndex(ZI_OFFSETS.STICKYGROUP_CEILING)
	const summary = ZusUtils.useStore(
		store,
		ZusUtils.useShallow((s: SettingsEditorState) => {
			let totalChanges = 0
			let totalErrors = 0
			let anyInvalid = false
			let anySaving = false
			for (const e of Object.values(s.sections)) {
				totalErrors += e.errorCount
				if (e.changedCount === 0) continue
				totalChanges += e.changedCount
				if (!e.valid) anyInvalid = true
				if (e.saving) anySaving = true
			}
			return { totalChanges, totalErrors, anyInvalid, anySaving }
		}),
	)

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

	async function handleSave() {
		const dirty = Object.values(store.getState().sections).filter((e) => e.changedCount > 0)
		if (dirty.length === 0 || dirty.some((e) => !e.valid)) return
		const result = await openDialog({
			title: 'Save settings?',
			content: (
				<div className="space-y-4">
					{dirty.map((e) => (
						<div key={e.key}>
							{dirty.length > 1 && <p className="mb-1 text-sm font-semibold">{e.label}</p>}
							<SettingsChangeList changes={e.getChanges()} />
						</div>
					))}
				</div>
			),
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') await Promise.all(dirty.map((e) => e.save()))
	}

	function handleReset() {
		for (const e of Object.values(store.getState().sections)) {
			if (e.changedCount > 0) e.reset()
		}
	}

	// the panel must stay reachable while multiple errors need chasing down, even with nothing to save yet
	if (summary.totalChanges === 0 && summary.totalErrors <= 1) return null

	return (
		<div
			style={{ zIndex }}
			className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg"
		>
			{summary.totalErrors > 0 && (
				<span className="flex items-center gap-0.5 text-sm font-medium text-destructive">
					<Icons.CircleAlert className="mr-1 h-4 w-4" />
					{summary.totalErrors} {summary.totalErrors === 1 ? 'error' : 'errors'}
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
			<span className="text-sm">
				<span className="font-medium">{summary.totalChanges}</span> {summary.totalChanges === 1 ? 'setting' : 'settings'} changed
			</span>
			<Button variant="outline" size="sm" onClick={handleReset}>Reset</Button>
			<Button size="sm" disabled={summary.anyInvalid || summary.anySaving} onClick={handleSave}>
				{summary.anySaving ? 'Saving…' : 'Save'}
			</Button>
		</div>
	)
}
