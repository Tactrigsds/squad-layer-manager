import React from 'react'

import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { useDebounced } from '@/hooks/use-debounce'
import * as CM from '@/lib/codemirror'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import * as Typo from '@/lib/typography'
import * as Yaml from '@/lib/yaml'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as F from '@/models/filter.models'
import * as FilterEditClient from '@/systems/filter-edit.client'
import * as MessagesClient from '@/systems/messages.client'
import { tr } from '@/systems/messages.client'

import { parseWithNodeComments, stringifyWithNodeComments } from './filter-text-editor.helpers'
import type { FilterTextEditorProps } from './filter-text-editor.types'
import YamlCompactSwitch from './yaml-compact-switch'

export default function FilterTextEditor(props: FilterTextEditorProps) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	// the filter the buffer currently represents, so the editor's own edits don't come back as a re-serialization
	const lastEmittedRef = React.useRef<F.EditableFilterNode | null>(null)
	const [errorText, setErrorText] = React.useState('')
	// re-rendering the buffer means parsing it first, so the switch is only offered while that can succeed
	const [parsable, setParsable] = React.useState(true)
	const [compact, setCompact] = React.useState(true)
	const gridRef = React.useRef<HTMLDivElement>(null)
	const dragging = React.useRef(false)
	const [errorsFraction, setErrorsFraction] = React.useState(FilterEditClient.loadErrorsFraction)
	// the editor is built once; the store subscription below reads the current mode without tearing it down
	const compactRef = React.useRef(compact)
	compactRef.current = compact

	const activeRef = React.useRef(props.active)

	const getState = () => Zus.getState(props.stores.filterEditor)

	function syncFromStore(view: CM.EditorView) {
		const node = F.treeToFilterNode(getState().tree)
		// an edit here round-trips through the frame and comes back as a new tree. Re-serializing on that would
		// rewrite the buffer under the cursor, which YAML's significant indentation makes worse than it was in JSON.
		if (Obj.deepEqual(node, lastEmittedRef.current)) return
		lastEmittedRef.current = node
		CM.setDoc(view, stringifyWithNodeComments(node, compactRef.current))
	}

	const onChange = React.useCallback(
		(value: string) => {
			// a setDoc since this edit has replaced it
			if (viewRef.current && value !== viewRef.current.state.doc.toString()) return
			let obj: any
			try {
				obj = parseWithNodeComments(value)
			} catch (err) {
				// a YAMLParseError message already carries the line, column and a code frame
				setErrorText(err instanceof Error ? err.message : String(err))
				setParsable(false)
				return
			}
			setParsable(true)
			const res = F.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				setErrorText(Yaml.stringifyDoc(res.error.issues))
				return
			}
			if (!F.isBlockType(res.data.type)) {
				setErrorText(`root node must be a block node: (${F.BLOCK_TYPES.join(', ')})`)
				return
			}

			setErrorText('')
			const valueChanged = !Obj.deepEqual(res.data, F.treeToFilterNode(getState().tree))
			if (valueChanged) {
				lastEmittedRef.current = res.data
				EditFrame.Actions.updateRoot(props.stores, res.data)
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[props.stores],
	)

	const onChangeDebounced = useDebounced({
		onChange: onChange,
		delay: 100,
	})

	// -------- setup editor, sync from store, handle change events --------
	React.useEffect(() => {
		const schemaJson = CM.toJsonSchema(F.FilterNodeSchema)
		lastEmittedRef.current = F.treeToFilterNode(getState().tree)
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: stringifyWithNodeComments(lastEmittedRef.current, compactRef.current),
			extensions: [
				...CM.yamlEditorExtensions(schemaJson),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged && !CM.isProgrammaticUpdate(u)) onChangeDebounced(u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view

		// remeasure when returning to a hidden tab, matching the old resize-on-visibility behavior
		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (!document.hidden) view.requestMeasure()
		})

		// a hidden editor is brought up to date when its tab is shown instead
		const unsub = Zus.resolveReadStore(props.stores.filterEditor).subscribe((frameState, prevFrameState) => {
			if (!activeRef.current || frameState.tree === prevFrameState.tree) return
			syncFromStore(view)
		})

		return () => {
			view.destroy()
			viewRef.current = null
			sub.unsubscribe()
			unsub()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onChangeDebounced, props.stores])

	React.useEffect(() => {
		activeRef.current = props.active
		if (props.active && viewRef.current) syncFromStore(viewRef.current)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.active])

	function switchCompact(next: boolean) {
		setCompact(next)
		const view = viewRef.current
		if (!view) return
		CM.setDoc(view, stringifyWithNodeComments(parseWithNodeComments(view.state.doc.toString()), next))
	}

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			let obj: any
			try {
				obj = parseWithNodeComments(view.state.doc.toString())
			} catch (err) {
				if (err instanceof Error) {
					toast.error(...tr.toast(F_Msgs.formatFailed(err.message)))
				}
				return
			}
			CM.setDoc(view, stringifyWithNodeComments(obj, compactRef.current))
		},
		focus: () => viewRef.current!.focus(),
	}))

	return (
		<div
			ref={gridRef}
			className="grid h-[500px] w-full grid-rows-[min-content_minmax(0,1fr)] gap-y-2 rounded-md"
			style={{ gridTemplateColumns: `minmax(0,${1 - errorsFraction}fr) auto minmax(0,${errorsFraction}fr)` }}
		>
			<div className="mb-2 ms-[45px] flex items-center gap-3">
				<h3 className={Typo.Small}>{tr.text(F_Msgs.filterHeading())}</h3>
				<YamlCompactSwitch className="ms-auto" compact={compact} disabled={!parsable} onChange={switchCompact} />
			</div>
			<span />
			<h3 className={Typo.Small + 'mb-2'}>{tr.text(F_Msgs.errorsHeading())}</h3>
			<div ref={editorEltRef} dir="ltr" className="min-h-0 overflow-hidden rounded-md border"></div>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={tr.text(F_Msgs.resizeErrors())}
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
					setErrorsFraction(FilterEditClient.clampErrorsFraction(fromEnd / rect.width))
				}}
				onPointerUp={(e) => {
					dragging.current = false
					e.currentTarget.releasePointerCapture(e.pointerId)
					FilterEditClient.saveErrorsFraction(errorsFraction)
				}}
				onDoubleClick={() => {
					setErrorsFraction(FilterEditClient.ERRORS_FRACTION.default)
					FilterEditClient.saveErrorsFraction(FilterEditClient.ERRORS_FRACTION.default)
				}}
			>
				<div className="w-0.5 rounded-full bg-transparent group-hover:bg-line-soft" />
			</div>
			<pre className="min-h-0 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-destructive ltr-isolate">
				{errorText}
			</pre>
		</div>
	)
}
