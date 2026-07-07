import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { useDebounced } from '@/hooks/use-debounce'
import * as CM from '@/lib/codemirror'
import * as Obj from '@/lib/object'
import * as Typography from '@/lib/typography.ts'
import * as ZusUtils from '@/lib/zustand'
import * as F from '@/models/filter.models'
import stringifyCompact from 'json-stringify-pretty-compact'
import React from 'react'
import * as Rx from 'rxjs'
import { toast } from 'sonner'
import type { FilterTextEditorProps } from './filter-text-editor.types'

export default function FilterTextEditor(props: FilterTextEditorProps) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	const [errorText, setErrorText] = React.useState('')

	const getState = () => ZusUtils.getState(props.stores.filterEditor)

	const onChange = React.useCallback(
		(value: string) => {
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch (err) {
				if (err instanceof SyntaxError) setErrorText(stringifyCompact(err.message))
				return
			}
			const res = F.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				setErrorText(stringifyCompact(res.error.issues))
				return
			}
			if (!F.isBlockType(res.data.type)) {
				setErrorText(stringifyCompact(`root node must be a block node: (${F.BLOCK_TYPES.join(', ')})`))
				return
			}

			setErrorText('')
			const valueChanged = !Obj.deepEqual(res.data, F.treeToFilterNode(getState().tree))
			if (valueChanged) EditFrame.Actions.updateRoot(props.stores, res.data)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[props.stores],
	)

	const onChangeDebounced = useDebounced({
		defaultValue: () => stringifyCompact(F.treeToFilterNode(getState().tree)),
		onChange: onChange,
		delay: 100,
	})

	// -------- setup editor, sync from store, handle change events --------
	React.useEffect(() => {
		const schemaJson = CM.toJsonSchema(F.FilterNodeSchema)
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: stringifyCompact(F.treeToFilterNode(getState().tree)),
			extensions: [
				...CM.jsonEditorExtensions(schemaJson),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged) onChangeDebounced(u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view

		// remeasure when returning to a hidden tab, matching the old resize-on-visibility behavior
		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (!document.hidden) view.requestMeasure()
		})

		let first = true
		const unsub = ZusUtils.resolveReadStore(props.stores.filterEditor).subscribe((frameState, prevFrameState) => {
			if (!first && frameState.tree === prevFrameState.tree) return
			first = false
			CM.setDoc(view, stringifyCompact(F.treeToFilterNode(frameState.tree)))
		})

		return () => {
			view.destroy()
			viewRef.current = null
			sub.unsubscribe()
			unsub()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onChangeDebounced, props.stores])

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			let obj: any
			try {
				obj = JSON.parse(view.state.doc.toString())
			} catch (err) {
				if (err instanceof SyntaxError) {
					toast('Unable to format: invalid json', { description: err.message })
				}
				return
			}
			CM.setDoc(view, stringifyCompact(obj))
		},
		focus: () => viewRef.current!.focus(),
	}))

	return (
		<div className="grid h-[500px] w-full grid-cols-[auto_600px] grid-rows-[min-content_minmax(0,1fr)] gap-2 rounded-md">
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Filter</h3>
			<h3 className={Typography.Small + 'mb-2'}>Errors</h3>
			<div ref={editorEltRef} className="min-h-0 overflow-hidden rounded-md border"></div>
			<pre className="min-h-0 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-destructive">{errorText}</pre>
		</div>
	)
}
