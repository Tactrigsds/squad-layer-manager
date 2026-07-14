import type React from 'react'
import type { z } from 'zod'

export type SchemaJsonEditorHandle = {
	format: () => void
	focus: () => void
	reset: () => void
}

export interface SchemaJsonEditorProps<TOut, TIn = TOut> {
	// TOut/TIn diverge for codec schemas (e.g. Zod.HumanTime): TIn is what's displayed/edited (e.g. '5m'), TOut is what onValidChange receives (e.g. 300000)
	schema: z.ZodType<TOut, TIn>
	// authoritative value to sync the editor's contents from; only re-syncs when it changes by value, so in-progress edits aren't clobbered by unrelated re-renders
	value: TIn
	// called (debounced) whenever the editor's contents change; null while the contents don't parse as JSON or fail schema validation
	onValidChange: (value: TOut | null) => void
	label?: string
	minHeightPx?: number
	// rendered in the editor's own header row, so it stays reachable in fullscreen (where the editor covers the page)
	toolbar?: React.ReactNode
	ref?: React.Ref<SchemaJsonEditorHandle>
}
