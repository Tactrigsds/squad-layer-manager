import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { RichText } from '@/components/rich-text'
import type SchemaYamlEditorComponent from '@/components/schema-yaml-editor'
import { TooltipButton } from '@/components/settings-form/controls'
import {
	COMMENT_PREVIEW_LENGTH,
	type CommentProps,
	DEBOUNCE_MS,
	effectiveDefault,
	type FieldMode,
	flattenWhitespace,
	formatDefaultValue,
	FormOptionsContext,
	type FormRoot,
	getAtPath,
	type Path,
	SavedRootContext,
	type SchemaNode,
	setAtPath,
	textOffsetAtPoint,
	toInputShape,
	useFieldValue,
	useReset,
	useSettingComment,
	ValidationContext,
	type ValueState,
} from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as Obj from '@/lib/object-utils'
import type * as Rx from '@/lib/rxjs'
import * as SettingsNav from '@/lib/settings-nav'
import { cn } from '@/lib/utils'
import type { z } from '@/lib/zod'
import * as Zus from '@/lib/zustand'
import * as CMD_Msgs from '@/messages/command.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as CMDH from '@/models/command-help.models'
import type * as CMD from '@/models/command.models'
import * as SETTINGS from '@/models/settings.models'
import * as ConfigClient from '@/systems/config.client'
import { tr } from '@/systems/messages.client'

// the per-field reset affordances: reset-to-saved (undo local edits back to the persisted baseline) and, when the field
// has a schema default, a "default: <value>" hint plus reset-to-default. Both buttons stay mounted and disable when the
// current value already matches their target, so the affordance is discoverable and its tooltip explains the state.
export function FieldResetControls({
	value$,
	reset$,
	onChange,
	node,
	path,
	showDefaultLabel,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	node: SchemaNode
	path: Path
	showDefaultLabel: boolean
}) {
	const value = useFieldValue(value$)
	const { saved } = React.useContext(SavedRootContext)
	const def = effectiveDefault(node)
	const savedValue = getAtPath(saved, path)
	const canResetSaved = saved !== undefined && !Obj.deepEqual(value, savedValue)
	const canResetDefault = def.has && !Obj.deepEqual(value, def.value)

	function resetTo(v: unknown) {
		onChange(structuredClone(v))
		reset$.next()
	}

	return (
		<div className="flex items-center gap-1 shrink-0">
			<TooltipButton
				disabled={!canResetSaved}
				tooltip={canResetSaved ? tr.text(SETTINGS_Msgs.resetToSaved()) : tr.text(SETTINGS_Msgs.alreadySaved())}
				onClick={() => resetTo(savedValue)}
			>
				<Icons.RotateCcw className="h-3.5 w-3.5" />
			</TooltipButton>
			{def.has && (
				<>
					{showDefaultLabel && (
						<span className="text-xs text-muted-foreground max-w-[12rem] truncate" title={formatDefaultValue(def.value)}>
							{tr.text(SETTINGS_Msgs.defaultHint(formatDefaultValue(def.value)))}
						</span>
					)}
					<TooltipButton
						disabled={!canResetDefault}
						tooltip={
							canResetDefault
								? tr.text(SETTINGS_Msgs.resetToDefault(formatDefaultValue(def.value)))
								: tr.text(SETTINGS_Msgs.alreadyDefault())
						}
						onClick={() => resetTo(def.value)}
					>
						<Icons.CornerDownLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
					</TooltipButton>
				</>
			)}
		</div>
	)
}

// an anchor to this field's fragment; shown on hover of its labeled row (the row carries `group`)
export function AnchorLink({ domId }: { domId: string }) {
	return (
		<a
			href={`#${domId}`}
			className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
			title={tr.text(SETTINGS_Msgs.linkToSetting())}
			aria-label={tr.text(SETTINGS_Msgs.linkToSetting())}
			onClick={(e) => {
				e.preventDefault()
				SettingsNav.navigateToAnchor(domId)
			}}
		>
			<Icons.Link className="h-3 w-3" />
		</a>
	)
}

// A link from a command's configuration to its listing on the commands page, where its arguments and examples are
// written down. Renders nothing for any other field. Revealed on hover of its row, like the anchor icon it sits beside.
export function CommandsPageCrossLink({ path }: { path: Path }) {
	if (path.length !== 2 || path[0] !== 'commands') return null
	return (
		<TSR.Link
			to="/commands"
			hash={CMDH.commandsPageAnchor(path[1] as CMD.CommandId)}
			className="shrink-0 text-xs text-muted-foreground underline-offset-2 opacity-0 transition-opacity hover:text-foreground hover:underline group-hover:opacity-100 focus-visible:opacity-100"
			title={tr.text(CMD_Msgs.commandsCrossLinkTitle())}
		>
			{tr.text(CMD_Msgs.commandsCrossLink())}
		</TSR.Link>
	)
}

// What the running install says about one setting, under its description: a setting that cannot take effect as
// configured says so where it is set. Keyed on the path before anything subscribes, so the other fields pay nothing.
export function FieldNotice({ path }: { path: Path }) {
	if (path.join('.') === 'discord.expandHistoryLinks') return <MessageContentNotice />
	return null
}

function MessageContentNotice() {
	const missing = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.discordMissingMessageContent)
	if (!missing) return null
	return (
		<p role="status" className="flex items-start gap-1 pt-0.5 text-xs text-warn dark:text-warn">
			<Icons.TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
			<span>{tr.text(SETTINGS_Msgs.discordMessageContentMissing())}</span>
		</p>
	)
}

// The comment block under a field's name: the text while displayed, a textarea while editing. Edits go straight into
// the root document, so a comment is staged and saved with the rest of the draft. Mirrors the filter editor's NodeComment.
export function SettingComment({ root, pathStr, writable, editing, setEditing, caretRef }: CommentProps) {
	const comment = useSettingComment(root.value$, pathStr)
	const [expanded, setExpanded] = React.useState(false)
	const setComment = React.useCallback(
		(text: string) => root.onChange(SETTINGS.withSettingComment(root.value$.getValue(), pathStr, text)),
		[root, pathStr],
	)
	const setCommentDebounced = useDebounced({ delay: DEBOUNCE_MS, onChange: setComment })

	if (editing) {
		return (
			<Textarea
				aria-label={tr.text(SETTINGS_Msgs.settingComment())}
				autoFocus
				rows={3}
				maxLength={SETTINGS.SETTING_COMMENT_MAX_LENGTH}
				placeholder={tr.text(SETTINGS_Msgs.commentPlaceholder())}
				defaultValue={comment ?? ''}
				className="my-1 text-xs"
				onFocus={(e) => {
					const at = caretRef.current ?? e.currentTarget.value.length
					e.currentTarget.setSelectionRange(at, at)
				}}
				onChange={(e) => setCommentDebounced(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') e.currentTarget.blur()
				}}
				onBlur={(e) => {
					setComment(e.target.value)
					setEditing(false)
				}}
			/>
		)
	}

	if (!comment) return null

	const { flat: flattened, origIndex } = flattenWhitespace(comment)
	const truncated = flattened.length > COMMENT_PREVIEW_LENGTH
	const collapsed = truncated && !expanded
	// clicking into the text opens the editor with the caret under the click, as a plain textarea would. Links keep
	// their own click (RichText stops it propagating), and so does the more/less toggle.
	const editAtClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!writable) return
		const offset = textOffsetAtPoint(e.currentTarget, e.clientX, e.clientY)
		caretRef.current = offset === null ? null : collapsed ? (origIndex[offset] ?? comment.length) : offset
		setEditing(true)
	}
	return (
		<div
			className={cn('my-1 flex items-start gap-1 border-s-2 border-muted ps-2 text-xs text-muted-foreground', writable && 'cursor-text')}
			onClick={editAtClick}
		>
			<RichText
				text={collapsed ? flattened : comment}
				maxLength={collapsed ? COMMENT_PREVIEW_LENGTH : undefined}
				className={cn('min-w-0', collapsed && 'whitespace-normal')}
			/>
			{truncated && (
				<button
					type="button"
					className="shrink-0 underline"
					onClick={(e) => {
						e.stopPropagation()
						setExpanded((v) => !v)
					}}
				>
					{expanded ? tr.text(SETTINGS_Msgs.showLess()) : tr.text(SETTINGS_Msgs.showMore())}
				</button>
			)}
		</div>
	)
}

// sits in the field's hover-revealed icon row beside AnchorLink. A field that has a comment keeps the icon showing, so
// the comment reads as something that can be edited.
export function CommentButton({ root, pathStr, editing, setEditing, caretRef }: CommentProps) {
	const hasComment = !!useSettingComment(root.value$, pathStr)
	const label = hasComment ? tr.text(UI_Msgs.editComment()) : tr.text(UI_Msgs.addComment())
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					aria-pressed={editing}
					className={cn(
						'shrink-0 transition-opacity focus-visible:opacity-100',
						hasComment ? 'text-primary' : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
					)}
					onClick={() => {
						caretRef.current = null
						setEditing(!editing)
					}}
				>
					<Icons.MessageSquareText className="h-3 w-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

// The collapsed tail of a section: the fields most installs never touch (see settings-groups.ts). `paths` are the
// dotted paths it holds, so it can open itself when one of them is navigated to (the TOC lists advanced settings like
// any other) or when one of them fails validation, which must never be hidden behind a collapsed row.
export function AdvancedDisclosure({ paths, children }: { paths: string[]; children: React.ReactNode }) {
	const [expanded, setExpanded] = React.useState(false)
	const { idPrefix } = React.useContext(FormOptionsContext)
	const covers = React.useCallback(
		(candidate: string, prefix: string) => {
			return paths.some((p) => {
				const full = `${prefix}${p}`
				return candidate === full || candidate.startsWith(`${full}.`)
			})
		},
		[paths],
	)

	React.useEffect(() => SettingsNav.onAnchorNavigate((id) => covers(id, idPrefix) && setExpanded(true)), [covers, idPrefix])

	const hasIssue = React.useContext(ValidationContext).some((i) => covers(i.path, ''))
	const open = expanded || hasIssue
	return (
		<div className="rounded-md border border-dashed">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={open}
			>
				<Icons.ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open ? 'rotate-90' : 'rtl:rotate-180')} />
				{tr.text(SETTINGS_Msgs.advanced())}
				<span className="opacity-60">({paths.length})</span>
				{hasIssue && <Icons.TriangleAlert className="h-3 w-3 text-destructive" />}
			</button>
			{open && <div className="space-y-3 border-t px-2 py-3">{children}</div>}
		</div>
	)
}

// lazily loaded so a settings visit that never opens a YAML editor doesn't pay for the CodeMirror bundle. The `as`
// casts restore the generic component signature React.lazy erases (same as the page-level editor in routes/settings).
const SchemaYamlEditor = React.lazy(
	() => import('@/components/schema-yaml-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaYamlEditorComponent

// the GUI/YAML segmented control the settings-page section headers use, scaled down to sit in a field's header row.
// `ms-auto` pins it to the right end of that row, where the page-level control sits in its own header.
export function LocalModeToggle({ mode, onSelect }: { mode: FieldMode; onSelect: (next: FieldMode) => void }) {
	return (
		<div className="ms-auto flex items-center rounded-md border p-0.5">
			{(['gui', 'yaml'] as const).map((option) => (
				<Button
					key={option}
					type="button"
					size="sm"
					variant={mode === option ? 'secondary' : 'ghost'}
					className="h-5 px-1.5 text-[10px]"
					onClick={() => onSelect(option)}
				>
					{option === 'gui' ? 'GUI' : 'YAML'}
				</Button>
			))}
		</div>
	)
}

// A YAML editor over one subtree of the form, swapped in for that field's widget. The editor owns its buffer while
// open: handing our own edits straight back as `value` would re-sync the document mid-keystroke, so it's only re-seeded
// on reset$, which is exactly the programmatic-change signal the uncontrolled inputs re-read on. Re-seeding remounts it
// rather than passing a new `value`, because the editor re-syncs only when `value` differs from what it last synced,
// and a reset typically restores the very value it was seeded with (leaving the user's edits sitting in the buffer).
export function LocalYamlField({
	schema,
	label,
	domId,
	path,
	value$,
	reset$,
	onChange,
	root,
}: {
	schema: z.ZodType
	label: string
	// the field's own anchor, which the editor renders inside: the scroll target once the editor is up
	domId: string
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	root: FormRoot
}) {
	const pathStr = path.join('.')
	// Every comment lives on the root document. The ones under this subtree ride into the editor keyed relative to it,
	// so they render as `#` lines, and come back out to the root in the same write as the subtree value.
	const seedValue = () => {
		const value = value$.getValue()
		if (!Obj.isPlainObject(value)) return value
		const comments = SETTINGS.subtreeComments(root.value$.getValue()?.[SETTINGS.COMMENTS_KEY], pathStr)
		return Object.keys(comments).length > 0 ? { ...value, [SETTINGS.COMMENTS_KEY]: comments } : value
	}
	const [seed, setSeed] = React.useState(() => ({ value: seedValue(), nonce: 0 }))
	useReset(reset$, () => setSeed((prev) => ({ value: seedValue(), nonce: prev.nonce + 1 })))
	const onValidChange = (v: unknown) => {
		if (v === null) return
		if (!Obj.isPlainObject(v)) return onChange(toInputShape(schema, v))
		const comments = (v[SETTINGS.COMMENTS_KEY] ?? {}) as SETTINGS.SettingsComments
		const next = setAtPath(root.value$.getValue(), path, toInputShape(schema, Obj.omit(v, [SETTINGS.COMMENTS_KEY])))
		root.onChange(SETTINGS.withSubtreeComments(next, pathStr, comments))
	}
	// only the first mount scrolls: re-seeding after a reset remounts the editor, and yanking the viewport for that
	// would be a surprise. This component only exists while the field is in YAML mode, so the ref resets on reopen.
	const broughtIntoView = React.useRef(false)
	const onReady = () => {
		if (broughtIntoView.current) return
		broughtIntoView.current = true
		SettingsNav.scrollToAnchorSettled(domId)
	}
	return (
		<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
			<SchemaYamlEditor
				key={seed.nonce}
				schema={schema}
				commentsKey={SETTINGS.COMMENTS_KEY}
				value={seed.value}
				onValidChange={onValidChange}
				onReady={onReady}
				minHeightPx={320}
				label={label}
			/>
		</React.Suspense>
	)
}
