// Lazily loaded: it pulls in CodeMirror and RFMT, which pulls in the whole `yaml` package.
import * as Icons from 'lucide-react'
import React from 'react'

import { describeParseError } from '@/components/layer-text-import.helpers'
import { LayerLineErrors } from '@/components/multi-layer-set-dialog'
import { describeLayerLine } from '@/components/multi-layer-set-dialog.helpers'
import { rotationCfg } from '@/components/rotation-cfg-language'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import * as RotationEditorFrame from '@/frames/rotation-editor.frame'
import * as CM from '@/lib/codemirror'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import type * as RFMT from '@/models/rotation-format.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

// The rotation's layers as text, in the format of the editor frame's view. The frame reads and applies what is typed;
// this only shows the text and what the frame found in it.
export default function RotationSourceEditor(props: { listHost: RotationEditorFrame.Key; editing: boolean }) {
	const { listHost } = props
	const format = Zus.useStore(listHost, (s) => s.view) as RFMT.Format
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	const [readOnly] = React.useState(() => new CM.Compartment())
	const editingRef = React.useRef(props.editing)
	editingRef.current = props.editing
	const formatName = tr.text(format === 'yaml' ? ROT_Msgs.formatYaml() : ROT_Msgs.formatText())

	React.useEffect(() => {
		const initial = Zus.getState(listHost).source
		let textSeq = initial.textSeq
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: initial.text,
			extensions: [
				...(format === 'yaml' ? CM.yamlEditorExtensions(undefined) : [...CM.plainTextEditorExtensions(), rotationCfg]),
				readOnly.of(CM.readOnly(!editingRef.current)),
				CM.EditorView.contentAttributes.of({ 'aria-label': tr.text(ROT_Msgs.sourceLabel(formatName)) }),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged && !CM.isProgrammaticUpdate(u)) RotationEditorFrame.Actions.editSource(listHost, u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view
		const unsub = Zus.resolveReadStore(listHost).subscribe((state) => {
			if (state.source.textSeq === textSeq) return
			textSeq = state.source.textSeq
			CM.setDoc(view, state.source.text)
		})
		return () => {
			unsub()
			view.destroy()
			viewRef.current = null
		}
	}, [listHost, format, formatName, readOnly])

	React.useEffect(() => {
		viewRef.current?.dispatch({ effects: readOnly.reconfigure(CM.readOnly(!props.editing)) })
	}, [props.editing, readOnly])

	return (
		<div className="flex flex-col">
			{!props.editing && (
				<p className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
					<Icons.Lock className="h-3.5 w-3.5" aria-hidden />
					{tr.text(ROT_Msgs.readOnlyHint())}
				</p>
			)}
			<div ref={editorEltRef} dir="ltr" className="max-h-[32rem] min-h-60 overflow-auto" />
			<SourceStatus listHost={listHost} formatName={formatName} editing={props.editing} />
		</div>
	)
}

function SourceStatus(props: { listHost: RotationEditorFrame.Key; formatName: string; editing: boolean }) {
	const analysis = Zus.useStore(props.listHost, (s) => s.source.analysis)
	const errors = analysis
		? [
				...analysis.parseErrors.map((error) => ({ lineNumber: error.line, text: error.text, reason: describeParseError(error) })),
				...analysis.lineErrors.map((line) => ({ lineNumber: line.lineNumber, text: line.text, reason: describeLayerLine(line) })),
			].sort((a, b) => a.lineNumber - b.lineNumber)
		: []
	return (
		<div className="flex flex-col gap-2 border-t bg-muted/40 px-3 py-2 text-xs">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span role="status" className="inline-flex items-center gap-1.5">
					{/* not a status of its own: it sits inside one, which already says the text is being read */}
					{(!analysis || analysis.pending) && <Spinner role={undefined} aria-hidden className="h-3.5 w-3.5 animate-spin" />}
					{analysis && tr.text(ROT_Msgs.importSummary(props.formatName, analysis.itemCount, analysis.noteCount))}
				</span>
				<span className="flex-1" />
				<span className="text-muted-foreground">{tr.text(ROT_Msgs.appliesAsYouType())}</span>
			</div>
			{analysis && analysis.unmatchedTags.length > 0 && (
				<ul className="flex flex-col gap-1.5">
					{analysis.unmatchedTags.map((label) => (
						<UnmatchedTag key={label} listHost={props.listHost} label={label} disabled={!props.editing} />
					))}
				</ul>
			)}
			<LayerLineErrors errors={errors} />
		</div>
	)
}

// the Select's value for a choice: the choice's type, or the tag id it maps onto
function choiceValue(choice: RotationEditorFrame.TagChoice | undefined): string | undefined {
	if (!choice) return undefined
	return choice.type === 'map' ? choice.tagId : choice.type
}

function UnmatchedTag(props: { listHost: RotationEditorFrame.Key; label: string; disabled: boolean }) {
	const choice = Zus.useStore(props.listHost, (s) => s.tagChoices.get(props.label.toLowerCase()))
	const configuredTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? EMPTY_TAGS)
	const canCreateTags = !RbacClient.useAccess('settings.global.upsertLayerTag')
	const choose = (value: string) => {
		const next: RotationEditorFrame.TagChoice | { type: 'create' } =
			value === 'create' || value === 'drop' ? { type: value } : { type: 'map', tagId: value }
		void RotationEditorFrame.Actions.chooseTag(props.listHost, props.label, next)
	}
	return (
		<li className="flex flex-wrap items-center gap-2">
			<Icons.CircleAlert className="h-4 w-4 text-warning" aria-hidden />
			<span className="min-w-0">{tr.text(ROT_Msgs.tagUnknown(props.label))}</span>
			<Select value={choiceValue(choice)} onValueChange={choose} disabled={props.disabled}>
				<SelectTrigger aria-label={tr.text(ROT_Msgs.tagChoiceLabel(props.label))} className="h-7 w-auto min-w-40">
					<SelectValue placeholder={tr.text(ROT_Msgs.tagChoicePlaceholder())} />
				</SelectTrigger>
				<SelectContent>
					{canCreateTags && <SelectItem value="create">{tr.text(ROT_Msgs.tagCreate())}</SelectItem>}
					<SelectItem value="drop">{tr.text(ROT_Msgs.tagDrop())}</SelectItem>
					{configuredTags.map((tag) => (
						<SelectItem key={tag.id} value={tag.id}>
							{tr.text(ROT_Msgs.tagMapTo(tag.label))}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</li>
	)
}

const EMPTY_TAGS: never[] = []
