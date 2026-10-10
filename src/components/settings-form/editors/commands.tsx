import * as Icons from 'lucide-react'
import React from 'react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { HelpTip, TextInputField } from '@/components/settings-form/controls'
import { mapValue, type OverrideProps, scopeValue, useFieldValue } from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import * as CMD_Msgs from '@/messages/command.messages'
import type * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'
import { tr } from '@/systems/messages.client'

// re-point an inline string from `oldPrefix` to `newPrefix`
function repointPrefix(str: string, oldPrefix: string, newPrefix: string): string {
	return newPrefix + str.slice(oldPrefix.length)
}

type CommandsMap = Record<string, { triggers?: CMD.CommandTrigger[] } | undefined>

// only a trigger's string carries a prefix; its args template is arguments, which never do
function mapTriggerStrings(commands: CommandsMap, fn: (s: string) => string): CommandsMap {
	const out: CommandsMap = {}
	for (const [id, cmd] of Object.entries(commands)) {
		out[id] = { ...cmd, triggers: (cmd?.triggers ?? []).map((t) => CMD.withTriggerString(t, fn(CMD.triggerString(t)))) }
	}
	return out
}

// one editable prefix. The char input is committed on blur/Enter (not per keystroke) because committing propagates a
// rewrite across every string using it; re-seeded by remounting (its key includes the committed value).
function PrefixRow({
	index,
	prefix,
	isDefault,
	usage,
	replyToUnknown,
	onCommit,
	onSetDefault,
	onSetReplyToUnknown,
	onRemove,
}: {
	index: number
	prefix: string
	isDefault: boolean
	usage: number
	replyToUnknown: boolean
	onCommit: (next: string) => void
	onSetDefault: () => void
	onSetReplyToUnknown: (next: boolean) => void
	onRemove: () => void
}) {
	const [draft, setDraft] = React.useState(prefix)
	const invalid = !CMD.isValidPrefix(draft.trim())
	// discard an invalid edit on blur (reverting to the committed value) rather than propagating a bad prefix into every string
	const commit = () => {
		const next = draft.trim()
		if (!CMD.isValidPrefix(next)) {
			setDraft(prefix)
			return
		}
		onCommit(next)
	}
	const removable = !isDefault && usage === 0
	return (
		<div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
			<span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
			<Input
				aria-label={tr.text(CMD_Msgs.prefixLabel(index + 1))}
				className={cn('h-7 w-16 font-mono text-sm ltr-isolate', invalid && 'border-destructive focus-visible:ring-destructive')}
				title={invalid ? CMD.PREFIX_ERROR : undefined}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault()
						e.currentTarget.blur()
					}
				}}
			/>
			<label className="flex items-center gap-1 text-xs text-muted-foreground">
				<input type="radio" checked={isDefault} onChange={onSetDefault} aria-label={tr.text(CMD_Msgs.makePrefixDefault(index + 1))} />
				{tr.text(CMD_Msgs.defaultPrefix())}
			</label>
			<label
				className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
				title={tr.text(CMD_Msgs.replyToUnknownHint())}
			>
				<Checkbox checked={replyToUnknown} onCheckedChange={(v) => onSetReplyToUnknown(v)} />
				{tr.text(CMD_Msgs.replyToUnknown())}
			</label>
			<span className="whitespace-nowrap text-xs text-muted-foreground">{tr.text(CMD_Msgs.prefixUses(usage))}</span>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 shrink-0 text-destructive disabled:opacity-40"
				aria-label={tr.text(CMD_Msgs.removePrefix(index + 1))}
				disabled={!removable}
				title={
					isDefault ? tr.text(CMD_Msgs.defaultPrefixNotRemovable()) : usage > 0 ? tr.text(CMD_Msgs.prefixStillUsed(usage)) : undefined
				}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</div>
	)
}

// bespoke editor for `allowedPrefixes`: prefixes are numbered so they have their own identity. Editing a prefix's
// characters propagates the change to every command string and timeout alias that uses it; one prefix is marked the
// default (new commands seed from it); a prefix in use can't be removed. Reads/writes siblings via the form root.
export function AllowedPrefixesField({ value$, reset$, root: formRoot }: OverrideProps) {
	const root = (useFieldValue(formRoot.value$) as { defaultPrefix?: string; commands?: CommandsMap } | undefined) ?? {}
	const prefixes = (useFieldValue(value$) as CMD.PrefixConfig[] | undefined) ?? []
	const commands = root.commands ?? {}
	const defaultPrefix = root.defaultPrefix ?? prefixes[0]?.prefix ?? ''

	const [newPrefix, setNewPrefix] = React.useState('')

	function writeRoot(patch: Record<string, unknown>) {
		const cur = (formRoot.value$.getValue() as Record<string, unknown>) ?? {}
		formRoot.onChange({ ...cur, ...patch })
		reset$.next()
	}

	function usageOf(prefix: string): number {
		let n = 0
		for (const cmd of Object.values(commands)) {
			for (const t of cmd?.triggers ?? []) if (CMD.prefixUsedBy(prefixes, CMD.triggerString(t))?.prefix === prefix) n++
		}
		return n
	}

	function commitEdit(idx: number, next: string) {
		const oldPrefix = prefixes[idx].prefix
		if (!next || next === oldPrefix || !CMD.isValidPrefix(next)) return
		const nextPrefixes = prefixes.map((p, i) => (i === idx ? { ...p, prefix: next } : p))
		// target by the OLD prefix list so longest-match stays stable while rewriting
		const nextCommands = mapTriggerStrings(commands, (s) =>
			CMD.prefixUsedBy(prefixes, s)?.prefix === oldPrefix ? repointPrefix(s, oldPrefix, next) : s,
		)
		writeRoot({
			allowedPrefixes: nextPrefixes,
			commands: nextCommands,
			defaultPrefix: defaultPrefix === oldPrefix ? next : defaultPrefix,
		})
	}

	const newTrimmed = newPrefix.trim()
	const newInvalid = newTrimmed !== '' && !CMD.isValidPrefix(newTrimmed)
	const newDuplicate = newTrimmed !== '' && prefixes.some((p) => p.prefix === newTrimmed)
	function addPrefix() {
		if (!newTrimmed || newInvalid || newDuplicate) return
		writeRoot({ allowedPrefixes: [...prefixes, { prefix: newTrimmed, replyToUnknown: true }] })
		setNewPrefix('')
	}

	function removePrefix(idx: number) {
		const { prefix } = prefixes[idx]
		if (prefix === defaultPrefix || usageOf(prefix) > 0) return
		writeRoot({ allowedPrefixes: prefixes.filter((_, i) => i !== idx) })
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">{tr.text(CMD_Msgs.prefixesBlurb())}</p>
			<div className="flex flex-wrap items-center gap-3">
				{prefixes.map((p, idx) => (
					<PrefixRow
						// key carries the committed value so the row's uncontrolled draft re-seeds on external change; idx keeps it unique across duplicate prefixes
						// oxlint-disable-next-line no-array-index-key
						key={`${idx}:${p.prefix}`}
						index={idx}
						prefix={p.prefix}
						isDefault={p.prefix === defaultPrefix}
						usage={usageOf(p.prefix)}
						replyToUnknown={p.replyToUnknown}
						onCommit={(next) => commitEdit(idx, next)}
						onSetDefault={() => writeRoot({ defaultPrefix: p.prefix })}
						onSetReplyToUnknown={(next) =>
							writeRoot({ allowedPrefixes: prefixes.map((q, i) => (i === idx ? { ...q, replyToUnknown: next } : q)) })
						}
						onRemove={() => removePrefix(idx)}
					/>
				))}
				<div className="flex items-center gap-2">
					<Input
						aria-label={tr.text(CMD_Msgs.newPrefix())}
						className={cn(
							'h-7 w-16 font-mono text-sm',
							(newInvalid || newDuplicate) && 'border-destructive focus-visible:ring-destructive',
						)}
						title={newInvalid ? CMD.PREFIX_ERROR : newDuplicate ? tr.text(CMD_Msgs.duplicatePrefix()) : undefined}
						placeholder="$"
						value={newPrefix}
						onChange={(e) => setNewPrefix(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								addPrefix()
							}
						}}
					/>
					<Button type="button" variant="outline" size="sm" disabled={!newTrimmed || newInvalid || newDuplicate} onClick={addPrefix}>
						{tr.text(CMD_Msgs.addPrefix())}
					</Button>
				</div>
			</div>
		</div>
	)
}

// The seed for a trigger being given pinned arguments. Correct as-is for a single-argument command; for anything else
// it fails validation immediately, and the message names the arguments the command actually takes, which is the
// fastest way to tell the admin what to write.
const NEW_TRIGGER_ARGS = '{{rest}}'

// bespoke editor for a command's `triggers` array (inline-prefixed, short). A plain trigger is one input; pinning
// arguments to it grows a second one on the same row rather than moving it to a table of its own, since it is still
// just a way of running this command.
function CommandTriggersField({ value$, reset$, onChange, root, cmdId }: OverrideProps & { cmdId: CMD.CommandId }) {
	const triggers = (useFieldValue(value$) as CMD.CommandTrigger[] | undefined) ?? []
	// scoped rather than read off the root: this field renders once per command, and subscribing each one to the whole
	// document would re-render all of them on every keystroke anywhere in the form
	const requireReasonFor$ = scopeValue(root.value$, 'requireReasonFor')
	const requireReasonFor = useFieldValue(requireReasonFor$) as AAR.AdminActionType[] | undefined
	const signature = React.useMemo(() => CMD.argTemplateSignature(cmdId, requireReasonFor ?? []), [cmdId, requireReasonFor])
	const current = () => (value$.getValue() as CMD.CommandTrigger[]) ?? []
	function structural(next: CMD.CommandTrigger[]) {
		onChange(next)
		reset$.next()
	}
	const setAt = (idx: number, next: CMD.CommandTrigger) => onChange(current().map((t, i) => (i === idx ? next : t)))

	return (
		<div className="space-y-1">
			{triggers.map((trigger, idx) => {
				const args = CMD.triggerArgs(trigger)
				const trigger$ = scopeValue(value$, idx)
				return (
					// oxlint-disable-next-line no-array-index-key
					<div key={idx} className="flex items-center gap-1">
						<div className="w-40 shrink-0">
							<TextInputField
								value$={mapValue(trigger$, (t) => CMD.triggerString(t ?? ''))}
								reset$={reset$}
								numeric={false}
								placeholder={tr.text(CMD_Msgs.triggerStringPlaceholder())}
								onChange={(v) => setAt(idx, CMD.withTriggerString(current()[idx] ?? '', v ?? ''))}
							/>
						</div>
						{args === undefined ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs text-muted-foreground"
								title={tr.text(CMD_Msgs.pinArgsHint())}
								onClick={() =>
									structural(current().map((t, i) => (i === idx ? { string: CMD.triggerString(t), args: NEW_TRIGGER_ARGS } : t)))
								}
							>
								{tr.text(CMD_Msgs.pinArgs())}
							</Button>
						) : (
							<>
								<div className="min-w-0 flex-1">
									<TextInputField
										value$={mapValue(trigger$, (t) => CMD.triggerArgs(t ?? '') ?? '')}
										reset$={reset$}
										numeric={false}
										placeholder={tr.text(CMD_Msgs.pinnedArgsPlaceholder())}
										onChange={(v) => {
											const t = current()[idx] ?? ''
											// Unpin's reset pulse reaches this input before it unmounts; taking that for an edit would re-pin the row
											if (CMD.triggerArgs(t) === undefined) return
											setAt(idx, { string: CMD.triggerString(t), args: v ?? '' })
										}}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs text-muted-foreground"
									title={tr.text(CMD_Msgs.unpinArgsHint())}
									onClick={() => structural(current().map((t, i) => (i === idx ? CMD.triggerString(t) : t)))}
								>
									{tr.text(CMD_Msgs.unpinArgs())}
								</Button>
							</>
						)}
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 shrink-0 text-destructive"
							aria-label={tr.text(CMD_Msgs.removeTrigger(idx + 1))}
							onClick={() => structural(triggers.filter((_, i) => i !== idx))}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)
			})}
			<div className="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onClick={() => structural([...current(), ''])}>
					<Icons.Plus className="me-1 h-4 w-4" />
					{tr.text(CMD_Msgs.addTrigger())}
				</Button>
			</div>
			{/* only where a template is actually being edited: this field renders once per command, and the signature under
			    every one of them buries the commands themselves */}
			{triggers.some((t) => CMD.triggerArgs(t) !== undefined) && (
				<div className="space-y-0.5 text-xs text-muted-foreground">
					{signature.length === 0 ? (
						<span>{tr.text(CMD_Msgs.takesNoArguments())}</span>
					) : (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span>{tr.text(CMD_Msgs.takesArguments())}</span>
							{signature.map(({ ref, arg }) => (
								<span key={ref} className="whitespace-nowrap">
									<code className="rounded bg-muted px-1 py-0.5 font-mono ltr-isolate">{ref}</code>
									<span className="ms-1 font-mono">{arg}</span>
								</span>
							))}
						</div>
					)}
					<span>{tr.text(CMD_Msgs.argTemplateHelp())}</span>
				</div>
			)}
		</div>
	)
}

// compact editor for a single command (`commands.<id>`): collapses the triggers/allowedChats/enabled sub-sections into a
// couple of tight rows, moving their descriptions into `?` tooltips. The command name + reset come from the LeafField
// shell. Schema issues (e.g. a trigger missing an allowed prefix) still surface under the card via the field's issues.
export function CommandCard({ value$, reset$, onChange, path, root }: OverrideProps) {
	const cmdId = path[1] as CMD.CommandId
	const cfg = (useFieldValue(value$) as { allowedChats?: CMD.ChatGroup[]; enabled?: boolean; quickReference?: boolean }) ?? {}
	const allowedChats = cfg.allowedChats ?? []
	const enabled = cfg.enabled ?? true
	const quickReference = cfg.quickReference ?? false
	const triggers$ = scopeValue(value$, 'triggers')
	function patch(p: Record<string, unknown>) {
		onChange({ ...((value$.getValue() as Record<string, unknown>) ?? {}), ...p })
	}
	return (
		<div className="space-y-2">
			<div className="space-y-1">
				<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
					{tr.text(CMD_Msgs.triggers())} <HelpTip text={tr.text(CMD_Msgs.triggersHelp())} />
				</span>
				<CommandTriggersField
					value$={triggers$}
					reset$={reset$}
					onChange={(v) => patch({ triggers: v })}
					path={[]}
					root={root}
					cmdId={cmdId}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex items-center gap-2">
					<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
						{tr.text(CMD_Msgs.allowedChats())} <HelpTip text={tr.text(CMD_Msgs.allowedChatsHelp())} />
					</span>
					<ComboBoxMulti
						title={tr.text(CMD_Msgs.allowedChats())}
						values={allowedChats}
						options={CMD.CHAT_GROUPS.options.map((group) => ({ value: group, label: tr.text(CMD_Msgs.chatGroupLabels[group]) }))}
						onSelect={(next) => patch({ allowedChats: typeof next === 'function' ? next(allowedChats) : next })}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Switch checked={enabled} onCheckedChange={(v) => patch({ enabled: v })} />
					{tr.text(CMD_Msgs.enabled())}
				</label>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Checkbox checked={quickReference} onCheckedChange={(v) => patch({ quickReference: v })} />
					<span className="flex items-center gap-1">
						{tr.text(CMD_Msgs.quickReference())}
						<HelpTip text={tr.text(CMD_Msgs.quickReferenceHelp())} />
					</span>
				</label>
			</div>
		</div>
	)
}
