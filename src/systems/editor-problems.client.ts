import * as UI_Msgs from '@/messages/ui.messages'
import type * as EP from '@/models/editor-problems.models'
import * as Clipboard from '@/systems/clipboard.client'
import { tr } from '@/systems/messages.client'

// -------- errors pane width --------

// the share of a text editor's width given to its problems pane, remembered per editor in localStorage

export const ERRORS_FRACTION = { min: 0.15, max: 0.75, default: 0.35 }

export const STORAGE_KEYS = {
	filter: 'slm:filterEditor:errorsFraction',
	rotation: 'slm:rotationEditor:errorsFraction',
	settings: 'slm:settingsYamlEditor:errorsFraction',
} as const
export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]

export function clampErrorsFraction(fraction: number) {
	return Math.min(ERRORS_FRACTION.max, Math.max(ERRORS_FRACTION.min, fraction))
}

export function loadErrorsFraction(key: StorageKey): number {
	try {
		const stored = localStorage.getItem(key)
		const raw = stored === null ? Number.NaN : Number(stored)
		if (!Number.isFinite(raw)) return ERRORS_FRACTION.default
		return clampErrorsFraction(raw)
	} catch {
		return ERRORS_FRACTION.default
	}
}

export function saveErrorsFraction(key: StorageKey, fraction: number) {
	try {
		localStorage.setItem(key, fraction.toFixed(3))
	} catch {
		// a browser with storage denied still resizes, it just does not remember
	}
}

// -------- actions --------

export function describe(problem: EP.Problem) {
	return tr.text(UI_Msgs.problemAt(problem.line, problem.column, problem.message))
}

export namespace Actions {
	export async function copy(problems: readonly EP.Problem[]) {
		await Clipboard.copy(problems.map(describe).join('\n'), tr.text(UI_Msgs.problemsNoun(problems.length)))
	}
}
