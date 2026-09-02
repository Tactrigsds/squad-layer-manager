import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as CM from '@/lib/codemirror'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils.ts'
import * as Yaml from '@/lib/yaml'
import type { z } from '@/lib/zod'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { BaseZIndexContext, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

import type { SchemaYamlEditorProps } from './schema-yaml-editor.types'
import YamlCompactSwitch from './yaml-compact-switch'

// When the editor renders comments (see `commentsKey`), the map is split off the value before the schema sees it and put
// back on the parsed result: the `#` lines it lives in are no part of the schema.
type Split = { obj: unknown; comments?: Yaml.PathComments }

function splitComments(value: unknown, commentsKey: string | undefined): Split {
	if (!commentsKey || !Obj.isPlainObject(value)) return { obj: value }
	const { [commentsKey]: comments, ...obj } = value
	return { obj, comments: (comments as Yaml.PathComments | undefined) ?? {} }
}

function parseText(text: string, commentsKey: string | undefined): Split {
	if (!commentsKey) return { obj: Yaml.parse(text) }
	const { value, comments } = Yaml.parseWithComments(text)
	return { obj: value, comments }
}

function stringifySplit(split: Split, commentsKey: string | undefined, compact: boolean): string {
	if (!commentsKey) return Yaml.stringifyDoc(split.obj, compact)
	return Yaml.stringifyDocWithComments(split.obj, split.comments ?? {}, compact)
}

function validate<TOut>(
	schema: z.ZodType<TOut, any>,
	split: Split,
	commentsKey: string | undefined,
): { success: true; data: TOut } | { success: false; issues: z.core.$ZodIssue[] } {
	const res = schema.safeParse(split.obj)
	if (!res.success) return { success: false, issues: res.error.issues }
	if (!commentsKey || !split.comments || !Obj.isPlainObject(res.data)) return { success: true, data: res.data }
	// a `comments:` map typed into the buffer by hand is superseded by the `#` lines
	const { [commentsKey]: _literal, ...rest } = res.data
	const data = Object.keys(split.comments).length > 0 ? { ...rest, [commentsKey]: split.comments } : rest
	return { success: true, data: data as TOut }
}

export default function SchemaYamlEditor<TOut, TIn = TOut>(props: SchemaYamlEditorProps<TOut, TIn>) {
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	const lastValidRef = React.useRef<TOut | null>(null)
	const lastSyncedValueRef = React.useRef<TIn>(props.value)
	const [errorText, setErrorText] = React.useState('')
	const [isFullscreen, setIsFullscreen] = React.useState(false)
	// re-rendering the buffer means parsing it first, so the switch is only offered while that can succeed
	const [parsable, setParsable] = React.useState(true)
	const [compact, setCompact] = React.useState(true)
	// the editor is built once; the effects below read the current mode without tearing it down
	const compactRef = React.useRef(compact)
	compactRef.current = compact

	const schemaRef = React.useRef(props.schema)
	schemaRef.current = props.schema
	const onValidChangeRef = React.useRef(props.onValidChange)
	onValidChangeRef.current = props.onValidChange
	const onReadyRef = React.useRef(props.onReady)
	onReadyRef.current = props.onReady
	const commentsKeyRef = React.useRef(props.commentsKey)
	commentsKeyRef.current = props.commentsKey

	const onChange = React.useCallback((value: string) => {
		let split: Split
		try {
			split = parseText(value, commentsKeyRef.current)
		} catch (err) {
			// a YAMLParseError message already carries the line, column and a code frame
			setErrorText(err instanceof Error ? err.message : String(err))
			setParsable(false)
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}
		setParsable(true)
		const res = validate(schemaRef.current, split, commentsKeyRef.current)
		if (!res.success) {
			setErrorText(Yaml.stringifyDoc(res.issues))
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
		const commentsKey = commentsKeyRef.current
		const schemaJson = CM.toJsonSchema(schemaRef.current)
		// the comments render as `#` lines, so completion and hover must not offer the key they are stored under
		const schemaProps = (schemaJson as { properties?: Record<string, unknown> } | undefined)?.properties
		if (commentsKey && schemaProps) delete schemaProps[commentsKey]
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: stringifySplit(splitComments(lastSyncedValueRef.current, commentsKey), commentsKey, compactRef.current),
			extensions: [
				...CM.yamlEditorExtensions(schemaJson),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged) onChangeDebounced(u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view

		const initialRes = validate(schemaRef.current, splitComments(lastSyncedValueRef.current, commentsKey), commentsKey)
		lastValidRef.current = initialRes.success ? initialRes.data : null
		onReadyRef.current?.()

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
		const commentsKey = commentsKeyRef.current
		const res = validate(schemaRef.current, splitComments(props.value, commentsKey), commentsKey)
		lastValidRef.current = res.success ? res.data : null
		if (viewRef.current)
			CM.setDoc(viewRef.current, stringifySplit(splitComments(props.value, commentsKey), commentsKey, compactRef.current))
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

	function switchCompact(next: boolean) {
		setCompact(next)
		const view = viewRef.current
		if (!view) return
		const commentsKey = commentsKeyRef.current
		CM.setDoc(view, stringifySplit(parseText(view.state.doc.toString(), commentsKey), commentsKey, next))
	}

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			const commentsKey = commentsKeyRef.current
			let split: Split
			try {
				split = parseText(view.state.doc.toString(), commentsKey)
			} catch {
				return
			}
			CM.setDoc(view, stringifySplit(split, commentsKey, compactRef.current))
		},
		focus: () => viewRef.current!.focus(),
		reset: () => {
			const view = viewRef.current!
			const commentsKey = commentsKeyRef.current
			const split = splitComments(lastSyncedValueRef.current, commentsKey)
			const res = validate(schemaRef.current, split, commentsKey)
			lastValidRef.current = res.success ? res.data : null
			CM.setDoc(view, stringifySplit(split, commentsKey, compactRef.current))
			setErrorText('')
			onValidChangeRef.current(lastValidRef.current)
		},
	}))
	// going fullscreen turns the editor into a dialog-level surface, so its own content re-bases onto it
	const baseZIndex = React.useContext(BaseZIndexContext)
	const contentBaseZIndex = isFullscreen ? baseZIndex + ZI_OFFSETS.DIALOG : baseZIndex

	return (
		<BaseZIndexContext.Provider value={contentBaseZIndex}>
			<div
				className={cn(
					'relative flex w-full flex-col gap-2 rounded-md',
					isFullscreen && 'fixed inset-0 h-screen w-screen bg-background p-4',
				)}
				style={isFullscreen ? { zIndex: contentBaseZIndex } : { height: props.minHeightPx ?? 400 }}
			>
				{/* pr-9 keeps the toolbar clear of the fullscreen toggle pinned to the container's corner */}
				<div className="flex min-h-7 items-center gap-2 pr-9">
					<h3 className={cn(Typo.Small, 'ml-[45px]')}>{props.label ?? 'Settings'}</h3>
					{/* the switch sits last so it lands in the same place whether or not the caller gave us a toolbar */}
					<div className="ml-auto flex min-w-0 items-center gap-2">
						{props.toolbar}
						<YamlCompactSwitch compact={compact} disabled={!parsable} onChange={switchCompact} />
					</div>
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="absolute top-0 right-0 h-7 w-7"
							style={{ zIndex: contentBaseZIndex + ZI_OFFSETS.MINOR_CEILING }}
							onClick={() => setIsFullscreen((v) => !v)}
						>
							{isFullscreen ? <Icons.Minimize2 className="h-4 w-4" /> : <Icons.Maximize2 className="h-4 w-4" />}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{isFullscreen ? tr.text(SETTINGS_Msgs.exitFullscreen()) : tr.text(SETTINGS_Msgs.fullscreen())}
					</TooltipContent>
				</Tooltip>
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
					<div ref={editorEltRef} className="min-h-0 overflow-hidden rounded-md border"></div>
					<div className="flex min-h-0 flex-col gap-2">
						<h3 className={Typo.Small}>{tr.text(SETTINGS_Msgs.yamlErrors())}</h3>
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-destructive">
							{errorText}
						</pre>
					</div>
				</div>
			</div>
		</BaseZIndexContext.Provider>
	)
}
