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
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { BaseZIndexContext, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

import type { SchemaYamlEditorProps } from './schema-yaml-editor.types'
import YamlCompactSwitch from './yaml-compact-switch'

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

	const onChange = React.useCallback((value: string) => {
		let obj: any
		try {
			obj = Yaml.parse(value)
		} catch (err) {
			// a YAMLParseError message already carries the line, column and a code frame
			setErrorText(err instanceof Error ? err.message : String(err))
			setParsable(false)
			lastValidRef.current = null
			onValidChangeRef.current(null)
			return
		}
		setParsable(true)
		const res = schemaRef.current.safeParse(obj)
		if (!res.success) {
			setErrorText(Yaml.stringifyDoc(res.error.issues))
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
			doc: Yaml.stringifyDoc(lastSyncedValueRef.current, compactRef.current),
			extensions: [
				...CM.yamlEditorExtensions(schemaJson),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged) onChangeDebounced(u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view

		const initialParseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
		lastValidRef.current = initialParseRes.success ? initialParseRes.data : null
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
		const parseRes = schemaRef.current.safeParse(props.value)
		lastValidRef.current = parseRes.success ? parseRes.data : null
		if (viewRef.current) CM.setDoc(viewRef.current, Yaml.stringifyDoc(props.value, compactRef.current))
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
		CM.setDoc(view, Yaml.stringifyDoc(Yaml.parse(view.state.doc.toString()), next))
	}

	React.useImperativeHandle(props.ref, () => ({
		format: () => {
			const view = viewRef.current!
			let obj: any
			try {
				obj = Yaml.parse(view.state.doc.toString())
			} catch {
				return
			}
			CM.setDoc(view, Yaml.stringifyDoc(obj, compactRef.current))
		},
		focus: () => viewRef.current!.focus(),
		reset: () => {
			const view = viewRef.current!
			const parseRes = schemaRef.current.safeParse(lastSyncedValueRef.current)
			lastValidRef.current = parseRes.success ? parseRes.data : null
			CM.setDoc(view, Yaml.stringifyDoc(lastSyncedValueRef.current, compactRef.current))
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
