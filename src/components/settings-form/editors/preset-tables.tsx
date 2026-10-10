import * as Icons from 'lucide-react'
import React from 'react'

import { ColorPicker } from '@/components/color-picker'
import { TextInputField } from '@/components/settings-form/controls'
import {
	DEBOUNCE_MS,
	FormOptionsContext,
	MessageVarsContext,
	type OverrideProps,
	scopeValue,
	useFieldValue,
	useReset,
	type ValueState,
} from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { MessagePreviewBox } from '@/components/warn-reasons-sub'
import { useDebounced } from '@/hooks/use-debounce'
import type * as Rx from '@/lib/rxjs'
import * as Templating from '@/lib/templating'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as LTag_Msgs from '@/messages/layer-tags.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as LP from '@/models/labeled-presets.models'
import * as LTag from '@/models/layer-tags.models'
import { tr } from '@/systems/messages.client'

// shared table shell for the label/keywords preset lists (admin action reasons)
type PresetRowProps = {
	idx: number
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: any[]) => void
	onRemove: () => void
}

function PresetTableField({
	value$,
	reset$,
	onChange,
	headers,
	newRow,
	Row,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any[]) => void
	headers: React.ReactNode
	newRow: (rows: object[]) => object
	Row: React.ComponentType<PresetRowProps>
}) {
	const value = (useFieldValue(value$) as object[] | undefined) ?? []

	// structural edits emit reset$ so the rows' uncontrolled inputs re-read after re-indexing
	function structural(next: object[]) {
		onChange(next)
		reset$.next()
	}

	return (
		<div className="space-y-1.5">
			{value.length > 0 && (
				<Table>
					<TableHeader>
						<TableRow>{headers}</TableRow>
					</TableHeader>
					<TableBody>
						{value.map((_, idx) => (
							<Row
								// rows have no stable id, same as ArrayField items
								// oxlint-disable-next-line no-array-index-key
								key={idx}
								idx={idx}
								parent$={value$}
								reset$={reset$}
								parentOnChange={onChange}
								onRemove={() => structural(((value$.getValue() as object[]) ?? []).filter((_, i) => i !== idx))}
							/>
						))}
					</TableBody>
				</Table>
			)}
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => {
					const rows = (value$.getValue() as object[]) ?? []
					structural([...rows, newRow(rows)])
				}}
			>
				<Icons.Plus className="h-4 w-4" />
				{tr.text(SETTINGS_Msgs.addItem())}
			</Button>
		</div>
	)
}

export function AdminActionReasonsField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-44">{tr.text(AAR_Msgs.labelColumn())}</TableHead>
					<TableHead>{tr.text(AAR_Msgs.textsColumn())}</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ label: '', keywords: [], actionTexts: {} })}
			Row={AdminActionReasonRow}
		/>
	)
}

export function LayerTagsField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-[12rem]">{tr.text(LTag_Msgs.labelColumn())}</TableHead>
					<TableHead>{tr.text(LTag_Msgs.descriptionColumn())}</TableHead>
					<TableHead className="w-[9rem]">{tr.text(LTag_Msgs.colorColumn())}</TableHead>
					<TableHead title={tr.text(LTag_Msgs.preventSwapsHint())}>{tr.text(LTag_Msgs.preventSwapsColumn())}</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={(rows) => ({ id: '', label: '', description: '', color: LTag.suggestColor(rows as LTag.Tag[]) })}
			Row={LayerTagRow}
		/>
	)
}

function LayerTagRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = scopeValue(parent$, idx)
	const descriptionRef = React.useRef<HTMLTextAreaElement>(null)
	const row = useFieldValue(row$) as LTag.Tag | undefined
	const colorRef = React.useRef<HTMLInputElement>(null)

	const setFields = (patch: Partial<LTag.Tag>) => {
		const arr = [...((parent$.getValue() as LTag.Tag[]) ?? [])]
		arr[idx] = { ...arr[idx], ...patch }
		parentOnChange(arr)
	}

	// a row's id is minted from the label the first time it's committed and is immutable from then on, so a later rename
	// keeps the tag attached to every layer carrying it. Only a row that has never had an id can still take one.
	const commitLabel = (label: string) => {
		const current = (parent$.getValue() as LTag.Tag[] | undefined)?.[idx]
		setFields(current?.id ? { label } : { label, id: label.trim() ? LTag.createTagId(label) : '' })
	}

	const setColor = (color: string) => {
		if (colorRef.current && colorRef.current.value !== color) colorRef.current.value = color
		setFields({ color })
	}

	return (
		<TableRow>
			<TableCell className="align-top">
				<Input
					defaultValue={row?.label ?? ''}
					maxLength={LTag.MAX_LABEL_LENGTH}
					placeholder={tr.text(LTag_Msgs.labelColumn())}
					onBlur={(e) => commitLabel(e.target.value)}
				/>
				{row?.id && <p className="mt-1 font-mono text-2xs text-muted-foreground ltr-isolate">{row.id}</p>}
			</TableCell>
			<TableCell className="align-top">
				<Textarea
					ref={descriptionRef}
					defaultValue={row?.description ?? ''}
					maxLength={LTag.MAX_DESCRIPTION_LENGTH}
					className="min-h-8 text-sm"
					placeholder={tr.text(LTag_Msgs.descriptionPlaceholder())}
					onBlur={(e) => setFields({ description: e.target.value })}
				/>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex items-center space-x-1">
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								title={tr.text(LTag_Msgs.pickColor())}
								className="h-6 w-6 shrink-0 rounded border"
								style={{ backgroundColor: row?.color ?? LTag.DELETED_TAG_COLOR }}
							/>
						</PopoverTrigger>
						<PopoverContent className="w-auto p-2">
							<ColorPicker color={row?.color ?? LTag.DELETED_TAG_COLOR} onChange={setColor} />
						</PopoverContent>
					</Popover>
					<Input
						ref={colorRef}
						defaultValue={row?.color ?? ''}
						maxLength={7}
						className="w-24 font-mono text-xs ltr-isolate"
						onBlur={(e) => setFields({ color: e.target.value.trim() })}
					/>
				</div>
			</TableCell>
			<TableCell className="align-top">
				<Checkbox
					className="mt-2"
					aria-label={tr.text(LTag_Msgs.preventSwapsColumn())}
					title={tr.text(LTag_Msgs.preventSwapsHint())}
					defaultChecked={!!row?.preventSwaps}
					onCheckedChange={(checked) => setFields({ preventSwaps: checked || undefined })}
				/>
			</TableCell>
			<TableCell className="align-top">
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-8 w-8 text-destructive"
					title={tr.text(LTag_Msgs.deleteTag())}
					onClick={onRemove}
				>
					<Icons.X className="h-4 w-4" />
				</Button>
			</TableCell>
		</TableRow>
	)
}

function AdminActionReasonRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const label$ = scopeValue(row$, 'label')
	const keywords$ = scopeValue(row$, 'keywords')
	const actionTexts$ = scopeValue(row$, 'actionTexts')
	const { idPrefix } = React.useContext(FormOptionsContext)
	// the set of actions this reason carries text for; keys are added/removed structurally (emits reset$)
	const actionTexts = (useFieldValue(actionTexts$) as Partial<Record<AAR.AdminActionType, string>> | undefined) ?? {}
	const presentActions = AAR.ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] !== undefined)
	const remainingActions = AAR.ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] === undefined)

	const setField = (key: keyof AAR.AdminActionReason) => (v: any) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], [key]: v }
		parentOnChange(arr)
	}
	// non-structural: text edit within an existing action key (no reset$; the textarea stays mounted)
	const setActionText = (action: AAR.AdminActionType) => (v: string) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: v } }
		parentOnChange(arr)
	}
	// structural: adding/removing an action key mounts/unmounts a textarea, so re-seed uncontrolled inputs via reset$
	const addAction = (action: AAR.AdminActionType) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: '' } }
		parentOnChange(arr)
		reset$.next()
	}
	const removeAction = (action: AAR.AdminActionType) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		const nextTexts = { ...arr[idx].actionTexts }
		delete nextTexts[action]
		arr[idx] = { ...arr[idx], actionTexts: nextTexts }
		parentOnChange(arr)
		reset$.next()
	}

	return (
		// the cell padding keeps the anchor highlight ring, drawn just outside the row, clear of the neighbouring rows' inputs
		<TableRow id={`${idPrefix}adminActionReasons.${idx}`} className="scroll-mt-2 [&>td]:py-1.5">
			<TableCell className="align-top gap-0.5 h-full">
				<TextInputField
					value$={label$}
					reset$={reset$}
					onChange={setField('label')}
					numeric={false}
					placeholder={tr.text(AAR_Msgs.labelPlaceholder())}
				/>
				<KeywordsCell value$={keywords$} reset$={reset$} seedFrom$={label$} onChange={setField('keywords')} />
			</TableCell>
			<TableCell className="align-top">
				<div className="space-y-1.5">
					{presentActions.length === 0 && <p className="text-xs text-destructive">{tr.text(AAR_Msgs.noActionTexts())}</p>}
					{presentActions.map((action) => {
						const text$ = scopeValue(actionTexts$, action)
						return (
							<div key={action} className="rounded-md border">
								<div className="flex items-center justify-between px-2 pt-1">
									<span className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
										{tr.text(AAR_Msgs.actionNames[action])}
									</span>
									<Button
										type="button"
										size="icon"
										variant="ghost"
										className="h-5 w-5 text-destructive"
										title={tr.text(AAR_Msgs.removeActionText(tr.text(AAR_Msgs.actionNames[action])))}
										onClick={() => removeAction(action)}
									>
										<Icons.X className="h-3.5 w-3.5" />
									</Button>
								</div>
								<TextAreaCell
									value$={text$}
									reset$={reset$}
									onChange={setActionText(action)}
									placeholder={tr.text(AAR_Msgs.actionTextPlaceholder(tr.text(AAR_Msgs.actionNames[action])))}
								/>
							</div>
						)
					})}
					{remainingActions.length > 0 && (
						<Select value="" onValueChange={(a) => addAction(a as AAR.AdminActionType)}>
							<SelectTrigger className="h-8">
								<SelectValue placeholder={tr.text(AAR_Msgs.addActionText())} />
							</SelectTrigger>
							<SelectContent>
								{remainingActions.map((a) => (
									<SelectItem key={a} value={a}>
										{tr.text(AAR_Msgs.actionNames[a])}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex flex-col gap-1">
					<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
						<Icons.X className="h-4 w-4" />
					</Button>
					<ReasonPreviewButton row$={row$} reset$={reset$} />
				</div>
			</TableCell>
		</TableRow>
	)
}

// the sample squad name the preview substitutes for {{squadName}} in squad-targeted contexts
const PREVIEW_SQUAD_NAME = 'Squad1'

// the verbatim rendered text each applicable context delivers in-game (squad contexts get the @Squad1 tag),
// with the given custom message variables applied. Standard variables (duration, squadName) are resolved per
// entry so custom variables referencing them render as they would at action time. timeouts are shown with a 2h
// sample duration, and again with the remaining duration (what enforcement re-renders on rejoin) so
// {{#duration}} sections can be checked both ways.
function reasonPreviewEntries(reason: AAR.AdminActionReason, varDefs: Templating.TemplateVarDef[]): { context: string; text: string }[] {
	const applied = (action: AAR.AdminActionType, opts?: { audienceTag?: string; extraVars?: Record<string, string> }) =>
		AAR.formatAppliedReason(action, reason, {
			audienceTag: opts?.audienceTag,
			vars: Templating.resolveTemplateVars(varDefs, { squadName: '', ...opts?.extraVars }),
		})
	const entries: { context: string; text: string }[] = []
	// kill/kick/timeout have squad forms delivering the same action text with {{squadName}} set, so a squad entry
	// is added only when it actually renders differently
	const pushSquadVariant = (action: AAR.AdminActionType, extraVars?: Record<string, string>) => {
		const base = applied(action, { extraVars })
		const squad = applied(action, { extraVars: { ...extraVars, squadName: PREVIEW_SQUAD_NAME } })
		if (squad !== base) {
			entries.push({ context: tr.text(AAR_Msgs.previewSquadVariant(tr.text(AAR_Msgs.actionNames[action]))), text: squad })
		}
	}
	// one entry per action the reason carries text for; squad-directed actions get the @Squad1 tag
	for (const action of AAR.ADMIN_ACTION_TYPE.options) {
		if (reason.actionTexts[action] === undefined) continue
		if (action === 'warn') {
			entries.push({ context: tr.text(AAR_Msgs.previewWarn()), text: applied('warn') })
			entries.push({
				context: tr.text(AAR_Msgs.previewWarnSquad()),
				text: applied('warn', { audienceTag: '@Squad1', extraVars: { squadName: PREVIEW_SQUAD_NAME } }),
			})
			continue
		}
		if (action === 'timeout') {
			entries.push({ context: tr.text(AAR_Msgs.previewTimeout()), text: applied('timeout', { extraVars: { duration: '2h' } }) })
			pushSquadVariant('timeout', { duration: '2h' })
			entries.push({ context: tr.text(AAR_Msgs.previewTimeoutExpired()), text: applied('timeout', { extraVars: { duration: '' } }) })
			continue
		}
		const squadTargeted = AAR.ADMIN_ACTIONS[action].targetKind === 'squad'
		entries.push({
			context: tr.text(AAR_Msgs.actionNames[action]),
			text: applied(action, {
				audienceTag: squadTargeted ? '@Squad1' : undefined,
				extraVars: squadTargeted ? { squadName: PREVIEW_SQUAD_NAME } : undefined,
			}),
		})
		if (action === 'kill' || action === 'kick') pushSquadVariant(action)
	}
	return entries
}

// message templates are rendered with Mustache (see src/lib/templating.ts), so link its reference rather than
// Handlebars': the two share {{variable}} and {{#section}}, but Handlebars' block helpers ({{#if}}, {{#each}}) are
// not available here, and pointing at docs that advertise them would send authors down a dead end
const TEMPLATE_SYNTAX_URL = 'https://mustache.github.io/mustache.5.html'

// which words are the link is the message's; where it points and how it looks are not
const trWithDocLink = tr.withTags({
	link: (chunks) => (
		<a href={TEMPLATE_SYNTAX_URL} target="_blank" rel="noopener noreferrer">
			{chunks}
		</a>
	),
})

function TemplateSyntaxHint() {
	return (
		<p className="text-xs text-muted-foreground [&_a]:text-info [&_a]:hover:underline">
			{trWithDocLink.richText(AAR_Msgs.templateSyntaxHint())}
		</p>
	)
}

function ReasonPreviewButton({ row$, reset$ }: { row$: ValueState; reset$: Rx.Subject<void> }) {
	const raw = useFieldValue(row$) as Partial<AAR.AdminActionReason> | undefined
	const varDefs = React.useContext(MessageVarsContext)
	// tolerate incomplete draft rows so the preview shows the message shape while it's being written
	const actionTexts = Object.fromEntries(
		Object.entries(raw?.actionTexts ?? {}).map(([action, text]) => [
			action,
			(text ?? '').trim() || tr.text(AAR_Msgs.previewMissingActionText()),
		]),
	) as Partial<Record<AAR.AdminActionType, string>>
	const reason: AAR.AdminActionReason = {
		label: raw?.label?.trim() || tr.text(AAR_Msgs.previewMissingLabel()),
		keywords: raw?.keywords ?? [],
		actionTexts,
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8" title={tr.text(AAR_Msgs.previewTitle())}>
					<Icons.Eye className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 space-y-2" align="end">
				<p className="text-xs text-muted-foreground">{tr.text(AAR_Msgs.previewBlurb())}</p>
				<TemplateSyntaxHint />
				{reasonPreviewEntries(reason, varDefs).map((entry) => (
					<div key={entry.context} className="space-y-1">
						<p className="text-xs font-medium">{entry.context}</p>
						<MessagePreviewBox>{entry.text}</MessagePreviewBox>
					</div>
				))}
			</PopoverContent>
		</Popover>
	)
}

// minimally-styled uncontrolled textarea cell: seeded from value$, edits debounced upward, re-read on reset$
function TextAreaCell({
	value$,
	reset$,
	onChange,
	placeholder,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: string) => void
	placeholder?: string
}) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
	const push = useDebounced<string>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(formatted)
		}
	})
	return (
		<Textarea
			ref={ref}
			rows={2}
			placeholder={placeholder}
			className="min-h-9 resize-y rounded-none border-0 shadow-none focus-visible:ring-0 px-2 py-1 font-mono text-xs"
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}

// Each keywords textarea fills the height its cell has left. Every cell mounting in one commit is measured in one
// pass and written in another, so a table of reasons costs one forced layout rather than one per row.
const pendingKeywordsFits = new Set<HTMLTextAreaElement>()

function scheduleKeywordsFit(elt: HTMLTextAreaElement) {
	if (pendingKeywordsFits.size === 0) queueMicrotask(fitKeywordsCells)
	pendingKeywordsFits.add(elt)
}

function fitKeywordsCells() {
	const elts = [...pendingKeywordsFits].filter((elt) => elt.isConnected && elt.parentElement)
	pendingKeywordsFits.clear()
	const heights = elts.map((elt) => {
		const parent = elt.parentElement!
		let others = 0
		for (const child of parent.children) if (child !== elt) others += (child as HTMLElement).offsetHeight
		return others > 0 ? parent.clientHeight - others : null
	})
	for (let i = 0; i < elts.length; i++) if (heights[i] !== null) elts[i].style.height = `${heights[i]}px`
}

// Keywords are edited as space/comma-separated text in a single cell and stored as string[] (a keyword can't contain
// whitespace, so the separators are unambiguous). A keyword is required, and typing one out for every reason is busy
// work, so the cell follows `seedFrom$` (the label) for as long as it still holds exactly what that seeded, or nothing
// at all. The first keyword the operator writes themselves stops it -- no dirty flag to keep in sync, since the input's
// own contents already say whether they've taken it over.
function KeywordsCell({
	value$,
	reset$,
	seedFrom$,
	onChange,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	seedFrom$: ValueState
	onChange: (v: string[]) => void
}) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: string[] | undefined) => (v ?? []).join('\n')
	const parse = (text: string) => text.split(/[,\s]+/).filter(Boolean)
	const push = useDebounced<string[]>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(parse(formatted))
		}
	})

	const seedSource = useFieldValue(seedFrom$) as string | undefined
	const lastSeed = React.useRef(LP.keywordFromLabel(seedSource ?? ''))
	React.useEffect(() => {
		const seed = LP.keywordFromLabel(seedSource ?? '')
		const previous = lastSeed.current
		lastSeed.current = seed
		if (seed === previous || !ref.current) return
		const current = ref.current.value.trim()
		if (current !== '' && current !== previous) return
		ref.current.value = seed
		push(parse(seed))
	}, [seedSource, push])

	return (
		<Textarea
			ref={(elt) => {
				ref.current = elt
				if (elt) scheduleKeywordsFit(elt)
			}}
			defaultValue={format(value$.getValue())}
			placeholder={tr.text(AAR_Msgs.keywordsPlaceholder())}
			onChange={(e) => push(parse(e.currentTarget.value))}
		/>
	)
}
