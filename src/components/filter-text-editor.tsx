import Ace from 'ace-builds'
import 'ace-builds/src-noconflict/mode-json'
import 'ace-builds/src-noconflict/theme-dracula'
import deepEqual from 'fast-deep-equal'
import stringifyCompact from 'json-stringify-pretty-compact'
import React from 'react'

import { useDebounced } from '@/hooks/use-debounce'
import { useToast } from '@/hooks/use-toast'
import * as Typography from '@/lib/typography.ts'
import * as M from '@/models.ts'

export type FilterTextEditorHandle = {
	format: () => void
	focus: () => void
}

type Editor = Ace.Ace.Editor
export type FilterTextEditorProps = {
	node: M.EditableFilterNode
	setNode: (node: M.FilterNode) => void
}
export function FilterTextEditor(props: FilterTextEditorProps, ref: React.ForwardedRef<FilterTextEditorHandle>) {
	const { setNode } = props
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const errorViewEltRef = React.useRef<HTMLDivElement>(null)

	// null if not currently valid node
	const editorValueObjRef = React.useRef(props.node as any)
	const editorRef = React.useRef<Editor>()
	function trySetEditorValue(obj: any) {
		if (editorValueObjRef.current !== null && deepEqual(obj, editorValueObjRef.current)) return
		editorValueObjRef.current = obj
		editorRef.current?.setValue(stringifyCompact(obj))
	}
	const errorViewRef = React.useRef<Editor>()
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
			editorValueObjRef.current = obj
			const res = M.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				errorViewRef.current!.setValue(stringifyCompact(res.error.issues))
				return
			}
			if (!M.isBlockType(res.data.type)) {
				errorViewRef.current!.setValue(stringifyCompact(`root node must be a block node: (${M.BLOCK_TYPES.join(', ')})`))
				return
			}

			errorViewRef.current!.setValue('')
			const valueChanged = !deepEqual(res.data, props.node)
			if (valueChanged) setNode(res.data)
		},
		[setNode, props.node]
	)
	const { setValue } = useDebounced({
		defaultValue: () => stringifyCompact(props.node),
		onChange,
		delay: 100,
	})

	const toaster = useToast()

	// -------- setup editor, handle events coming from editor, resizing --------
	React.useEffect(() => {
		const editor = Ace.edit(editorEltRef.current!, {
			value: stringifyCompact(props.node),
			mode: 'ace/mode/json',
			theme: 'ace/theme/dracula',
			useWorker: false,
			wrap: true,
		})
		const errorView = Ace.edit(errorViewEltRef.current!, {
			focusTimeout: 0,
			value: '',
			mode: 'ace/mode/json',
			theme: 'ace/theme/dracula',
			useWorker: false,
			readOnly: true,
			wrap: true,
		})
		const ro = new ResizeObserver(() => {
			return editor.resize()
			errorView.resize()
		})
		editor.on('change', () => {
			setValue(editor.getValue())
		})
		editorRef.current = editor
		errorViewRef.current = errorView
		const initialRes = M.FilterNodeSchema.safeParse(props.node)
		if (!initialRes.success) {
			errorView.setValue(stringifyCompact(initialRes.error))
		}

		return () => {
			editor.destroy()
			ro.disconnect()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	React.useEffect(() => {
		trySetEditorValue(props.node)
	}, [props.node])
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

export default React.forwardRef(FilterTextEditor)
