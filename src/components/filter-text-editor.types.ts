import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import type React from 'react'

export type FilterTextEditorHandle = {
	format: () => void
	focus: () => void
}

export interface FilterTextEditorProps {
	stores: EditFrame.KeyProp
	ref?: React.Ref<FilterTextEditorHandle>
}
