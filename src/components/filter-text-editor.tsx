// WARNING: the ordering of imports  matters here unfortunately. be careful when changing
import Ace from 'ace-builds'
import 'ace-builds/src-noconflict/mode-json'
import 'ace-builds/src-noconflict/theme-dracula'

import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import { getFrameReaderStore, getFrameState } from '@/frames/frame-manager'
import { useDebounced } from '@/hooks/use-debounce'
import { useToast } from '@/hooks/use-toast'
import * as Obj from '@/lib/object'
import * as Typography from '@/lib/typography.ts'
import * as F from '@/models/filter.models'
import stringifyCompact from 'json-stringify-pretty-compact'
import React from 'react'
import * as Rx from 'rxjs'

export type FilterTextEditorHandle = {
	format: () => void
	focus: () => void
}

type Editor = Ace.Ace.Editor
export interface FilterTextEditorProps {
	frameKey: EditFrame.Key
	ref?: React.Ref<FilterTextEditorHandle>
}
export default function FilterTextEditor(props: FilterTextEditorProps) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const errorViewEltRef = React.useRef<HTMLDivElement>(null)
	const ref = props.ref
	const editorRef = React.useRef<Editor>(null)
	const errorViewRef = React.useRef<Editor>(null)

	const getState = () => getFrameState(props.frameKey)

	const onChange = React.useCallback(
		(value: string) => {
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch (err) {
				if (err instanceof SyntaxError) {
					errorViewRef.current!.setValue(stringifyCompact(err.message))
				}
				return
			}
			const res = F.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				errorViewRef.current!.setValue(stringifyCompact(res.error.issues))
				return
			}
			if (!F.isBlockType(res.data.type)) {
				errorViewRef.current!.setValue(stringifyCompact(`root node must be a block node: (${F.BLOCK_TYPES.join(', ')})`))
				return
			}

			errorViewRef.current!.setValue('')
			const valueChanged = !Obj.deepEqual(res.data, F.treeToFilterNode(getState().tree))
			if (valueChanged) getState().updateRoot(res.data)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[props.frameKey],
	)

	const onChangeDebounced = useDebounced({
		defaultValue: () => stringifyCompact(F.treeToFilterNode(getState().tree)),
		onChange: onChange,
		delay: 100,
	})

	const toaster = useToast()

	// -------- setup editor, handle events coming from editor, resizing --------
	React.useEffect(() => {
		const editor = Ace.edit(editorEltRef.current!, {
			value: '',
			mode: 'ace/mode/json',
			theme: 'ace/theme/dracula',
			useWorker: false,
			wrap: true,
		})
		const errorView = Ace.edit(errorViewEltRef.current!, {
			focusTimeout: 0,
			value: '',
			// mode: 'ace/mode/json',
			// theme: 'ace/theme/dracula',
			useWorker: false,
			readOnly: true,
			wrap: true,
		})
		const ro = new ResizeObserver(() => {
			editor.resize()
			errorView.resize()
		})

		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (document.hidden) return
			editor.resize()
			errorView.resize()
		})

		editor.on('change', () => {
			onChangeDebounced(editor.getValue())
		})

		let first = true
		const unsub = getFrameReaderStore(props.frameKey).subscribe((frameState, prevFrameState) => {
			if (!first && frameState.tree === prevFrameState.tree) return
			first = false
			editor.setValue(stringifyCompact(F.treeToFilterNode(frameState.tree)))
		})

		editorRef.current = editor
		errorViewRef.current = errorView
		{
			const tree = getFrameReaderStore(props.frameKey).getState().tree
			editor.setValue(stringifyCompact(F.treeToFilterNode(tree)))
		}

		return () => {
			editor.destroy()
			ro.disconnect()
			sub.unsubscribe()
			unsub()
		}
	}, [onChangeDebounced, props.frameKey])

	React.useImperativeHandle(ref, () => ({
		format: () => {
			const value = editorRef.current!.getValue()
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch (err) {
				if (err instanceof SyntaxError) {
					toaster.toast({
						title: 'Unable to format: invalid json',
						description: err.message,
					})
				}
				return
			}
			editorRef.current!.setValue(stringifyCompact(obj))
		},
		focus: () => {
			// for some reason the value is out of date when swapping tabs unless we include this line
			editorRef.current!.setValue(editorRef.current!.getValue())
			editorRef.current!.focus()
		},
	}))
	return (
		<div className="grid h-[500px] w-full grid-cols-[auto_600px] grid-rows-[min-content_auto] rounded-md">
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Filter</h3>
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Errors</h3>
			<div ref={editorEltRef}></div>
			<div ref={errorViewEltRef}></div>
		</div>
	)
}
