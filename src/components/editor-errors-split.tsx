import React from 'react'

import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import * as EditorProblemsClient from '@/systems/editor-problems.client'
import * as MessagesClient from '@/systems/messages.client'
import { tr } from '@/systems/messages.client'

// A text editor beside its errors pane, with a draggable divider between them. Double-clicking the divider restores
// the default width.
export default function EditorErrorsSplit(props: {
	storageKey: EditorProblemsClient.StorageKey
	headers?: { editor: React.ReactNode; errors: React.ReactNode }
	editor: React.ReactNode
	errors: React.ReactNode
	className?: string
}) {
	const gridRef = React.useRef<HTMLDivElement>(null)
	const dragging = React.useRef(false)
	const [errorsFraction, setErrorsFraction] = React.useState(() => EditorProblemsClient.loadErrorsFraction(props.storageKey))
	const save = (fraction: number) => EditorProblemsClient.saveErrorsFraction(props.storageKey, fraction)

	return (
		<div
			ref={gridRef}
			className={cn(
				'grid w-full gap-y-2',
				props.headers ? 'grid-rows-[min-content_minmax(0,1fr)]' : 'grid-rows-[minmax(0,1fr)]',
				props.className,
			)}
			style={{ gridTemplateColumns: `minmax(0,${1 - errorsFraction}fr) auto minmax(0,${errorsFraction}fr)` }}
		>
			{props.headers && (
				<>
					{props.headers.editor}
					<span />
					{props.headers.errors ?? <span />}
				</>
			)}
			{props.editor}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={tr.text(UI_Msgs.resizeErrors())}
				className="group flex w-2 cursor-col-resize touch-none justify-center"
				onPointerDown={(e) => {
					dragging.current = true
					e.currentTarget.setPointerCapture(e.pointerId)
				}}
				onPointerMove={(e) => {
					if (!dragging.current) return
					const rect = gridRef.current!.getBoundingClientRect()
					// the errors pane is at the inline end
					const fromEnd = MessagesClient.textDirection() === 'rtl' ? e.clientX - rect.left : rect.right - e.clientX
					setErrorsFraction(EditorProblemsClient.clampErrorsFraction(fromEnd / rect.width))
				}}
				onPointerUp={(e) => {
					dragging.current = false
					e.currentTarget.releasePointerCapture(e.pointerId)
					save(errorsFraction)
				}}
				onDoubleClick={() => {
					setErrorsFraction(EditorProblemsClient.ERRORS_FRACTION.default)
					save(EditorProblemsClient.ERRORS_FRACTION.default)
				}}
			>
				<div className="w-0.5 rounded-full bg-transparent group-hover:bg-line-soft" />
			</div>
			{props.errors}
		</div>
	)
}
