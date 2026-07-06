import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as CM from '@/lib/codemirror'
import * as Obj from '@/lib/object'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import stringifyCompact from 'json-stringify-pretty-compact'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import type { SchemaJsonEditorProps } from './schema-json-editor.types'

export default function SchemaJsonEditor<TOut, TIn = TOut>(props: SchemaJsonEditorProps<TOut, TIn>) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	const lastValidRef = React.useRef<TOut | null>(null)
	const lastSyncedValueRef = React.useRef<TIn>(props.value)
	const [errorText, setErrorText] = React.useState('')
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
			if (err instanceof SyntaxError) setErrorText(stringifyCompact(err.message))
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}
		const res = schemaRef.current.safeParse(obj)
		if (!res.success) {
			setErrorText(stringifyCompact(res.error.issues))
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}

		setErrorText('')
		const valueChanged = !Obj.deepEqual(res.data, lastValidRef.current)
		if (valueChanged) {
			lastValidRef.current = res.data
			onValidChangeRef.current(res.data)
		}
	}, [])

	const onChangeDebounced = useDebounced({ onChange, delay: 100 })

	// -------- setup editor, handle change events --------
	React.useEffect(() => {
		const schemaJson = CM.toJsonSchema(schemaRef.current)
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: stringifyCompact(lastSyncedValueRef.current),
			extensions: [
				...CM.jsonEditorExtensions(schemaJson),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged) onChangeDebounced(u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view

		const initialParseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
		lastValidRef.current = initialParseRes.success ? initialParseRes.data : null

		// remeasure when returning to a hidden tab, matching the old resize-on-visibility behavior
		const sub = Rx.fromEvent(document, 'visibilitychange').subscribe(() => {
			if (!document.hidden) view.requestMeasure()
		})

		return () => {
			view.destroy()
			viewRef.current = null
			sub.unsubscribe()
		}
	}, [onChangeDebounced])

	// -------- re-sync editor contents when the authoritative value changes (e.g. after a save, or an external update) --------
	React.useEffect(() => {
		if (Obj.deepEqual(lastSyncedValueRef.current, props.value) && lastValidRef.current !== null) return
		lastSyncedValueRef.current = props.value
		const parseRes = schemaRef.current.safeParse(props.value)
		lastValidRef.current = parseRes.success ? parseRes.data : null
		if (viewRef.current) CM.setDoc(viewRef.current, stringifyCompact(props.value))
		setErrorText('')
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

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			let obj: any
			try {
				obj = JSON.parse(view.state.doc.toString())
			} catch {
				return
			}
			CM.setDoc(view, stringifyCompact(obj))
		},
		focus: () => viewRef.current!.focus(),
		reset: () => {
			const view = viewRef.current!
			const parseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
			lastValidRef.current = parseRes.success ? parseRes.data : null
			CM.setDoc(view, stringifyCompact(lastSyncedValueRef.current))
			setErrorText('')
			onValidChangeRef.current(lastValidRef.current)
		},
	}))

	return (
		<div
			className={cn(
				'relative grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-[min-content_minmax(0,1fr)] gap-2 rounded-md',
				isFullscreen && 'fixed inset-0 z-50 h-screen w-screen bg-background p-4',
			)}
			style={isFullscreen ? undefined : { height: props.minHeightPx ?? 400 }}
		>
			<h3 className={Typography.Small + 'mb-2 ml-[45px]'}>{props.label ?? 'Settings'}</h3>
			<h3 className={Typography.Small + 'mb-2'}>Errors</h3>
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
			<div ref={editorEltRef} className="min-h-0 overflow-hidden rounded-md border"></div>
			<pre className="min-h-0 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-destructive">{errorText}</pre>
		</div>
	)
}
