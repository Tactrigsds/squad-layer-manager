// WARNING: the ordering of imports  matters here unfortunately. be careful when changing
import Ace from 'ace-builds'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as Obj from '@/lib/object'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import stringifyCompact from 'json-stringify-pretty-compact'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import type { z } from 'zod'

export type SchemaJsonEditorHandle = {
	format: () => void
	focus: () => void
	reset: () => void
}

type Editor = Ace.Ace.Editor

export interface SchemaJsonEditorProps<TOut, TIn = TOut> {
	// TOut/TIn diverge for codec schemas (e.g. Zod.HumanTime): TIn is what's displayed/edited (e.g. '5m'), TOut is what onValidChange receives (e.g. 300000)
	schema: z.ZodType<TOut, TIn>
	// authoritative value to sync the editor's contents from; only re-syncs when it changes by value, so in-progress edits aren't clobbered by unrelated re-renders
	value: TIn
	// called (debounced) whenever the editor's contents change; null while the contents don't parse as JSON or fail schema validation
	onValidChange: (value: TOut | null) => void
	label?: string
	minHeightPx?: number
	ref?: React.Ref<SchemaJsonEditorHandle>
}

let pluginsLoading$: Promise<unknown> | false = Promise.all([
	import('ace-builds/src-noconflict/mode-json'),
	import('ace-builds/src-noconflict/theme-dracula'),
]).then(
	() => (pluginsLoading$ = false),
)

export default function SchemaJsonEditor<TOut, TIn = TOut>(props: SchemaJsonEditorProps<TOut, TIn>) {
	if (pluginsLoading$) throw pluginsLoading$
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const errorViewEltRef = React.useRef<HTMLDivElement>(null)
	const ref = props.ref
	const editorRef = React.useRef<Editor>(null)
	const errorViewRef = React.useRef<Editor>(null)
	const lastValidRef = React.useRef<TOut | null>(null)
	const lastSyncedValueRef = React.useRef<TIn>(props.value)

	const [isFullscreen, setIsFullscreen] = React.useState(false)

	const schemaRef = React.useRef(props.schema)
	schemaRef.current = props.schema
	const onValidChangeRef = React.useRef(props.onValidChange)
	onValidChangeRef.current = props.onValidChange

	const onChange = React.useCallback((value: string) => {
		let obj: any
		try {
			obj = JSON.parse(value)
		} catch (err) {
			if (err instanceof SyntaxError) {
				errorViewRef.current!.setValue(stringifyCompact(err.message))
			}
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}
		const res = schemaRef.current.safeParse(obj)
		if (!res.success) {
			errorViewRef.current!.setValue(stringifyCompact(res.error.issues))
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}

		errorViewRef.current!.setValue('')
		const valueChanged = !Obj.deepEqual(res.data, lastValidRef.current)
		if (valueChanged) {
			lastValidRef.current = res.data
			onValidChangeRef.current(res.data)
		}
	}, [])

	const onChangeDebounced = useDebounced({
		onChange: onChange,
		delay: 100,
	})

	// -------- setup editor, handle events coming from editor, resizing --------
	React.useEffect(() => {
		const editor = Ace.edit(editorEltRef.current!, {
			value: stringifyCompact(lastSyncedValueRef.current),
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
			editor.resize()
			errorView.resize()
		})
		ro.observe(editorEltRef.current!)
		ro.observe(errorViewEltRef.current!)

		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (document.hidden) return
			editor.resize()
			errorView.resize()
		})

		editor.on('change', () => {
			onChangeDebounced(editor.getValue())
		})

		const initialParseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
		lastValidRef.current = initialParseRes.success ? initialParseRes.data : null
		editorRef.current = editor
		errorViewRef.current = errorView

		return () => {
			editor.destroy()
			errorView.destroy()
			ro.disconnect()
			sub.unsubscribe()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onChangeDebounced])

	// -------- re-sync editor contents when the authoritative value changes (e.g. after a save, or an external update) --------
	React.useEffect(() => {
		if (Obj.deepEqual(lastSyncedValueRef.current, props.value) && lastValidRef.current !== null) return
		lastSyncedValueRef.current = props.value
		const parseRes = schemaRef.current.safeParse(props.value)
		lastValidRef.current = parseRes.success ? parseRes.data : null
		editorRef.current?.setValue(stringifyCompact(props.value))
		errorViewRef.current?.setValue('')
	}, [props.value])

	// -------- exit fullscreen on Escape --------
	React.useEffect(() => {
		if (!isFullscreen) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation()
				setIsFullscreen(false)
			}
		}
		document.addEventListener('keydown', onKeyDown, true)
		return () => document.removeEventListener('keydown', onKeyDown, true)
	}, [isFullscreen])

	React.useImperativeHandle(ref, () => ({
		format: () => {
			const value = editorRef.current!.getValue()
			let obj: any
			try {
				obj = JSON.parse(value)
			} catch {
				return
			}
			editorRef.current!.setValue(stringifyCompact(obj))
		},
		focus: () => {
			// for some reason the value is out of date when swapping tabs unless we include this line
			editorRef.current!.setValue(editorRef.current!.getValue())
			editorRef.current!.focus()
		},
		reset: () => {
			const parseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
			lastValidRef.current = parseRes.success ? parseRes.data : null
			editorRef.current!.setValue(stringifyCompact(lastSyncedValueRef.current))
			errorViewRef.current!.setValue('')
			onValidChangeRef.current(lastValidRef.current)
		},
	}))

	return (
		<div
			className={cn(
				'relative grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-[min-content_auto] rounded-md',
				isFullscreen && 'fixed inset-0 z-50 h-screen w-screen bg-background p-4',
			)}
			style={isFullscreen ? undefined : { height: props.minHeightPx ?? 400 }}
		>
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>{props.label ?? 'Settings'}</h3>
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>Errors</h3>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="absolute top-0 right-0 z-10 h-7 w-7"
						onClick={() => setIsFullscreen(v => !v)}
					>
						{isFullscreen ? <Icons.Minimize2 className="h-4 w-4" /> : <Icons.Maximize2 className="h-4 w-4" />}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}</TooltipContent>
			</Tooltip>
			<div ref={editorEltRef}></div>
			<div ref={errorViewEltRef}></div>
		</div>
	)
}
