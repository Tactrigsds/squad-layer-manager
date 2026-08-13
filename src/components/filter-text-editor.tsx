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
import { tr } from '@/systems/messages.client'

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
	// the editor is built once; the store subscription below reads the current mode without tearing it down
	const compactRef = React.useRef(compact)
	compactRef.current = compact

	const getState = () => Zus.getState(props.stores.filterEditor)

	const onChange = React.useCallback(
		(value: string) => {
			let obj: any
			try {
				obj = Yaml.parse(value)
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
			doc: Yaml.stringifyDoc(lastEmittedRef.current, compactRef.current),
			extensions: [
				...CM.yamlEditorExtensions(schemaJson),
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

		const unsub = Zus.resolveReadStore(props.stores.filterEditor).subscribe((frameState, prevFrameState) => {
			if (frameState.tree === prevFrameState.tree) return
			const node = F.treeToFilterNode(frameState.tree)
			// an edit here round-trips through the frame and comes back as a new tree. Re-serializing on that would
			// rewrite the buffer under the cursor, which YAML's significant indentation makes worse than it was in JSON.
			if (Obj.deepEqual(node, lastEmittedRef.current)) return
			lastEmittedRef.current = node
			CM.setDoc(view, Yaml.stringifyDoc(node, compactRef.current))
		})

		return () => {
			view.destroy()
			viewRef.current = null
			sub.unsubscribe()
			unsub()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onChangeDebounced, props.stores])

	function switchCompact(next: boolean) {
		setCompact(next)
		const view = viewRef.current
		if (!view) return
		CM.setDoc(view, Yaml.stringifyDoc(Yaml.parse(view.state.doc.toString()), next))
	}

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			let obj: any
			try {
				obj = Yaml.parse(view.state.doc.toString())
			} catch (err) {
				if (err instanceof Error) {
					toast.error(...tr.toast(F_Msgs.formatFailed(err.message)))
				}
				return
			}
			CM.setDoc(view, Yaml.stringifyDoc(obj, compactRef.current))
		},
		focus: () => viewRef.current!.focus(),
	}))

	return (
		<div className="grid h-[500px] w-full grid-cols-[auto_600px] grid-rows-[min-content_minmax(0,1fr)] gap-2 rounded-md">
			<div className="mb-2 ml-[45px] flex items-center gap-3">
				<h3 className={Typo.Small}>{tr.text(F_Msgs.filterHeading())}</h3>
				<YamlCompactSwitch className="ml-auto" compact={compact} disabled={!parsable} onChange={switchCompact} />
			</div>
			<h3 className={Typo.Small + 'mb-2'}>{tr.text(F_Msgs.errorsHeading())}</h3>
			<div ref={editorEltRef} className="min-h-0 overflow-hidden rounded-md border"></div>
			<pre className="min-h-0 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-destructive">
				{errorText}
			</pre>
		</div>
	)
}
