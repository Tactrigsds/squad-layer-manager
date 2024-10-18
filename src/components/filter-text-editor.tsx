import Ace from 'ace-builds'
import 'ace-builds/src-noconflict/mode-json'
import 'ace-builds/src-noconflict/theme-github_dark'
import deepEqual from 'fast-deep-equal'
import stringifyCompact from 'json-stringify-pretty-compact'
import React from 'react'

import { useDebounced } from '@/hooks/use-debounce'
import { useToast } from '@/hooks/use-toast'
import * as Typography from '@/lib/typography.ts'
import * as M from '@/models.ts'

export type FilterTextEditorHandle = {
	format: () => void
}

type Editor = Ace.Ace.Editor
export type FilterTextEditorProps = {
	node: M.EditableFilterNode
	setNode: (node: M.FilterNode) => void
}
export function FilterTextEditor(props: FilterTextEditorProps, ref: React.ForwardedRef<FilterTextEditorHandle>) {
	const { setNode } = props
	const editorEltRet = React.useRef<HTMLDivElement>(null)
	const errorViewEltRef = React.useRef<HTMLDivElement>(null)
	const editorRef = React.useRef<Editor>()
	const errorViewRef = React.useRef<Editor>()
	const onChange = React.useCallback(
		(value: string) => {
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch (err) {
				if (err instanceof SyntaxError) {
					errorViewRef.current!.setValue(stringifyCompact({ error: err.message }))
				}
				return
			}
			const res = M.FilterNodeSchema.safeParse(obj)
			if (!res.success) {
				errorViewRef.current!.setValue(stringifyCompact({ error: res.error }))
				return
			}

			errorViewRef.current!.setValue('')
			const valueChanged = !deepEqual(res.data, props.node)
			if (valueChanged) setNode(res.data)
		},
		[setNode, props.node]
	)
	const { setValue } = useDebounced({
		defaultValue: stringifyCompact(props.node),
		onChange,
		delay: 50,
	})

	const toaster = useToast()

	// -------- setup editor, handle events coming from editor, resizing --------
	React.useEffect(() => {
		const editor = Ace.edit(editorEltRet.current!, {
			value: stringifyCompact(props.node),
			mode: 'ace/mode/json',
			theme: 'ace/theme/github_dark',
			useWorker: false,
			wrap: true,
		})
		const errorView = Ace.edit(errorViewEltRef.current!, {
			value: '',
			mode: 'ace/mode/json',
			theme: 'ace/theme/github_dark',
			useWorker: false,
			readOnly: true,
			wrap: true,
		})
		const ro = new ResizeObserver(() => {
			return editor.resize()
			errorView.resize()
		})
		editor.on('input', () => {
			setValue(editor.getValue())
		})
		editorRef.current = editor
		errorViewRef.current = errorView
		const initialRes = M.FilterNodeSchema.safeParse(props.node)
		if (!initialRes.success) errorView.setValue(stringifyCompact(initialRes.error))

		return () => {
			editor.destroy()
			ro.disconnect()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	React.useImperativeHandle(ref, () => ({
		format: () => {
			const value = editorRef.current!.getValue()
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch (err) {
				if (err instanceof SyntaxError) {
					toaster.toast({ title: err.message })
				}
				return
			}
			editorRef.current!.setValue(stringifyCompact(obj))
		},
	}))
	return (
		<div className="w-full h-[500px] rounded-md grid grid-cols-[auto_600px] grid-rows-[min-content_auto]">
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Filter</h3>
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Errors</h3>
			<div ref={editorEltRet}></div>
			<div ref={errorViewEltRef}></div>
		</div>
	)
}

export default React.forwardRef(FilterTextEditor)
