import type React from 'react'

import type * as EditFrame from '@/frames/filter-editor.frame.ts'

export type FilterTextEditorHandle = {
	format: () => void
	focus: () => void
}

export interface FilterTextEditorProps {
	stores: EditFrame.KeyProp
	ref?: React.Ref<FilterTextEditorHandle>
}
