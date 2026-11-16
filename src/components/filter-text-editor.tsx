import React from 'react'

import EditorErrorsSplit from '@/components/editor-errors-split'
import EditorProblems from '@/components/editor-problems'
import { FullscreenSurface, FullscreenToggle } from '@/components/fullscreen'
import * as Typo from '@/components/typography'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import * as CM from '@/lib/codemirror'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounce'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as EP from '@/models/editor-problems.models'
import * as F from '@/models/filter.models'
import * as EditorProblemsClient from '@/systems/editor-problems.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import { problemAtPath, schemaProblems, yamlErrorProblem } from './editor-problems.helpers'
import { parseWithNodeComments, stringifyWithNodeComments } from './filter-text-editor.helpers'
import type { FilterTextEditorProps } from './filter-text-editor.types'
import YamlCompactSwitch from './yaml-compact-switch'

export default function FilterTextEditor(props: FilterTextEditorProps) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	// the filter the buffer currently represents, so the editor's own edits don't come back as a re-serialization
	const lastEmittedRef = React.useRef<F.EditableFilterNode | null>(null)
	const [problems, setProblems] = React.useState<EP.Problem[]>([])
	// re-rendering the buffer means parsing it first, so the switch is only offered while that can succeed
	const [parsable, setParsable] = React.useState(true)
	const [compact, setCompact] = React.useState(true)
	const [fullscreen, setFullscreen] = React.useState(false)
	// the editor is built once; the store subscription below reads the current mode without tearing it down
	const compactRef = React.useRef(compact)
	compactRef.current = compact

	const activeRef = React.useRef(props.active)

	const getState = () => Zus.getState(props.stores.filterEditor)

	// the buffer's own problems. Lowering problems are listed only while there are none, since only then does the
	// buffer hold the tree that was lowered.
	const textProblemsRef = React.useRef<EP.Problem[]>([])
	function showProblems(view: CM.EditorView | null) {
		const state = getState()
		const lowering =
			view && textProblemsRef.current.length === 0 && EditFrame.Sel.loweringCurrent(state)
				? loweringProblems(view.state.doc.toString(), EditFrame.Sel.errors(state))
				: []
		const next = lowering.length > 0 ? [...textProblemsRef.current, ...lowering] : textProblemsRef.current
		setProblems(next)
		if (view) CM.showProblems(view, next)
	}

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
			const report = (next: EP.Problem[]) => {
				textProblemsRef.current = next
				showProblems(viewRef.current)
			}
			let obj: any
			try {
				obj = parseWithNodeComments(value)
			} catch (err) {
				report([yamlErrorProblem(value, err)])
				setParsable(false)
				return
			}
			setParsable(true)
			const res = F.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				report(schemaProblems(value, res.error.issues))
				return
			}
			if (!F.isBlockType(res.data.type)) {
				report([problemAtPath(value, ['type'], tr.text(F_Msgs.rootMustBeBlock(F.BLOCK_TYPES.join(', '))))])
				return
			}

			report([])
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
					// a setDoc is checked too, so the problems shown always describe the text. Applying it is a no-op, since
					// it matches the filter already.
					if (u.docChanged) onChangeDebounced(u.state.doc.toString())
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
			if (!activeRef.current) return
			if (frameState.tree !== prevFrameState.tree) syncFromStore(view)
			if (frameState.lowered !== prevFrameState.lowered) showProblems(view)
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
		if (props.active && viewRef.current) {
			syncFromStore(viewRef.current)
			showProblems(viewRef.current)
		}
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
				const text = view.state.doc.toString()
				toast.error(...tr.toast(F_Msgs.formatFailed(EditorProblemsClient.describe(yamlErrorProblem(text, err)))))
				return
			}
			CM.setDoc(view, stringifyWithNodeComments(obj, compactRef.current))
		},
		focus: () => viewRef.current!.focus(),
	}))

	return (
		<FullscreenSurface fullscreen={fullscreen} onExit={() => setFullscreen(false)} className="flex flex-col">
			<EditorErrorsSplit
				storageKey={EditorProblemsClient.STORAGE_KEYS.filter}
				className={fullscreen ? 'min-h-0 flex-1' : 'h-[500px]'}
				headers={{
					editor: (
						<div className="mb-2 ms-[45px] flex items-center gap-3">
							<h3 className={Typo.Small}>{tr.text(F_Msgs.filterHeading())}</h3>
							<YamlCompactSwitch className="ms-auto" compact={compact} disabled={!parsable} onChange={switchCompact} />
							<FullscreenToggle fullscreen={fullscreen} onToggle={() => setFullscreen((v) => !v)} />
						</div>
					),
					errors: null,
				}}
				editor={<div ref={editorEltRef} dir="ltr" className="min-h-0 overflow-hidden rounded-md border"></div>}
				errors={<EditorProblems problems={problems} onSelect={(problem) => CM.revealPosition(viewRef.current!, problem.from)} />}
			/>
		</FullscreenSurface>
	)
}

// an error inside a referenced filter is placed on the apply-filter node it was reached through
function loweringProblems(text: string, errors: F.NodeValidationError[]) {
	return errors.flatMap((error) => {
		if (error.part !== 'filter') return []
		const owner = error.via.length > 0 && error.ownerFilterId ? FilterEntityClient.filterEntities.get(error.ownerFilterId) : undefined
		const message = owner ? tr.text(F_Msgs.referencedProblemText(owner.name, error.msg)) : tr.text(error.msg)
		const path = error.rootPath.map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment))
		return [problemAtPath(text, path, message)]
	})
}
