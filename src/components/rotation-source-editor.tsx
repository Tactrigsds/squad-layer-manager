// Lazily loaded: it pulls in CodeMirror and RFMT, which pulls in the whole `yaml` package.
import * as Icons from 'lucide-react'
import React from 'react'

import EditorErrorsSplit from '@/components/editor-errors-split'
import EditorProblems from '@/components/editor-problems'
import { describeParseError } from '@/components/layer-text-import.helpers'
import { describeLayerLine } from '@/components/multi-layer-set-dialog.helpers'
import { rotationCfg } from '@/components/rotation-cfg-language'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import * as RotationEditorFrame from '@/frames/rotation-editor.frame'
import * as CM from '@/lib/codemirror'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as EP from '@/models/editor-problems.models'
import type * as RFMT from '@/models/rotation-format.models'
import * as EditorProblemsClient from '@/systems/editor-problems.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

// The rotation's layers as text, in the format of the editor frame's view. The frame reads and applies what is typed;
// this only shows the text and what the frame found in it.
export default function RotationSourceEditor(props: { listHost: RotationEditorFrame.Key; writable: boolean }) {
	const { listHost } = props
	const format = Zus.useStore(listHost, (s) => s.view) as RFMT.Format
	const editorEltRef = React.useRef<HTMLDivElement>(null)
	const viewRef = React.useRef<CM.EditorView | null>(null)
	const [readOnly] = React.useState(() => new CM.Compartment())
	const writableRef = React.useRef(props.writable)
	writableRef.current = props.writable
	const fullscreen = Zus.useStore(listHost, (s) => s.fullscreen)
	const formatName = tr.text(format === 'yaml' ? ROT_Msgs.formatYaml() : ROT_Msgs.formatText())

	React.useEffect(() => {
		const initial = Zus.getState(listHost).source
		let textSeq = initial.textSeq
		const view = new CM.EditorView({
			parent: editorEltRef.current!,
			doc: initial.text,
			extensions: [
				...(format === 'yaml' ? CM.yamlEditorExtensions(undefined) : [...CM.plainTextEditorExtensions(), rotationCfg]),
				readOnly.of(CM.readOnly(!writableRef.current)),
				CM.EditorView.contentAttributes.of({ 'aria-label': tr.text(ROT_Msgs.sourceLabel(formatName)) }),
				CM.EditorView.updateListener.of((u) => {
					if (u.docChanged && !CM.isProgrammaticUpdate(u)) RotationEditorFrame.Actions.editSource(listHost, u.state.doc.toString())
				}),
			],
		})
		viewRef.current = view
		const showProblems = (state: RotationEditorFrame.State) => {
			// an analysis describes the text it was made from, which typing may have moved past
			if (state.source.text === view.state.doc.toString()) CM.showProblems(view, Sel.problems(state))
		}
		showProblems(Zus.getState(listHost))
		const unsub = Zus.resolveReadStore(listHost).subscribe((state, prev) => {
			if (state.source.textSeq !== textSeq) {
				textSeq = state.source.textSeq
				CM.setDoc(view, state.source.text)
			}
			if (state.source.analysis !== prev.source.analysis || state.source.text !== prev.source.text) showProblems(state)
		})
		return () => {
			unsub()
			view.destroy()
			viewRef.current = null
		}
	}, [listHost, format, formatName, readOnly])

	React.useEffect(() => {
		viewRef.current?.dispatch({ effects: readOnly.reconfigure(CM.readOnly(!props.writable)) })
	}, [props.writable, readOnly])

	// YAML lines run long, so its problems go in a column beside the editor rather than below it
	const problemsBeside = format === 'yaml'
	const reveal = (problem: EP.Problem) => CM.revealPosition(viewRef.current!, problem.from)
	return (
		<div className={cn('flex flex-col', fullscreen && 'min-h-0 flex-1')}>
			{problemsBeside ? (
				<EditorErrorsSplit
					storageKey={EditorProblemsClient.STORAGE_KEYS.rotation}
					className={cn('p-2', fullscreen ? 'min-h-0 flex-1' : 'h-[40rem]')}
					editor={<div ref={editorEltRef} dir="ltr" className="min-h-0 overflow-hidden rounded-md border" />}
					errors={<SourceProblems listHost={listHost} writable={props.writable} onSelect={reveal} />}
				/>
			) : (
				<div ref={editorEltRef} dir="ltr" className={cn('overflow-auto', fullscreen ? 'min-h-0 flex-1' : 'max-h-[32rem] min-h-60')} />
			)}
			<div className="flex flex-col gap-2 border-t bg-muted/40 px-3 py-2 text-xs">
				<SourceSummary listHost={listHost} formatName={formatName} />
				{!problemsBeside && (
					<SourceProblems listHost={listHost} writable={props.writable} onSelect={reveal} className="max-h-60" hideWhenEmpty />
				)}
			</div>
		</div>
	)
}

function SourceSummary(props: { listHost: RotationEditorFrame.Key; formatName: string }) {
	const analysis = Zus.useStore(props.listHost, (s) => s.source.analysis)
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span role="status" className="inline-flex items-center gap-1.5">
				{/* not a status of its own: it sits inside one, which already says the text is being read */}
				{(!analysis || analysis.pending) && <Spinner role={undefined} aria-hidden className="h-3.5 w-3.5 animate-spin" />}
				{analysis && tr.text(ROT_Msgs.importSummary(props.formatName, analysis.itemCount, analysis.noteCount))}
			</span>
			<span className="flex-1" />
			<span className="text-muted-foreground">{tr.text(ROT_Msgs.appliesAsYouType())}</span>
		</div>
	)
}

// the lines that could not be read, and the tags that match none configured
function SourceProblems(props: {
	listHost: RotationEditorFrame.Key
	writable: boolean
	onSelect: (problem: EP.Problem) => void
	className?: string
	hideWhenEmpty?: boolean
}) {
	const problems = Zus.useStore(props.listHost, Sel.problems)
	const unmatchedTags = Zus.useStore(props.listHost, Sel.unmatchedTags)
	if (props.hideWhenEmpty && problems.length === 0 && unmatchedTags.length === 0) return null
	return (
		<EditorProblems problems={problems} onSelect={props.onSelect} className={props.className} otherCount={unmatchedTags.length}>
			{unmatchedTags.map((label) => (
				<UnmatchedTag key={label} listHost={props.listHost} label={label} disabled={!props.writable} />
			))}
		</EditorProblems>
	)
}

namespace Sel {
	const problemsByAnalysis = new WeakMap<RotationEditorFrame.SourceAnalysis, EP.Problem[]>()

	// what the analysis found, at the lines of the text it was made from
	export function problems(state: RotationEditorFrame.State): EP.Problem[] {
		const { analysis, text } = state.source
		if (!analysis) return NO_PROBLEMS
		let problems = problemsByAnalysis.get(analysis)
		if (!problems) {
			problems = [
				...analysis.parseErrors.map((error) => EP.onLine(text, error.line, describeParseError(error))),
				...analysis.lineErrors.map((line) => EP.onLine(text, line.lineNumber, describeLayerLine(line) ?? line.text)),
			].sort(EP.byPosition)
			problemsByAnalysis.set(analysis, problems)
		}
		return problems
	}

	export function unmatchedTags(state: RotationEditorFrame.State): readonly string[] {
		return state.source.analysis?.unmatchedTags ?? NO_TAGS
	}
}

const NO_PROBLEMS: EP.Problem[] = []
const NO_TAGS: string[] = []

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
		<li className="flex flex-wrap items-center gap-2 px-1.5 py-1">
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
