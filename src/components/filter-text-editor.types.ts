import type React from 'react'

import type * as EditFrame from '@/frames/filter-editor.frame.ts'

export type FilterTextEditorHandle = {
	format: () => void
	focus: () => void
}

export interface FilterTextEditorProps {
	stores: EditFrame.KeyProp
	// whether the text tab is showing; the buffer follows the filter only while it is
	active: boolean
	ref?: React.Ref<FilterTextEditorHandle>
}
