import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { BmFlagSelect } from '@/components/bm-flag-picker'
import { ColorPicker } from '@/components/color-picker'
import ComboBox, { type ComboBoxOption } from '@/components/combo-box/combo-box'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DiscordRoleSelect } from '@/components/discord-picker'
import { TextInputField } from '@/components/settings-form/controls'
import { type OverrideProps, scopeValue, useFieldValue, useReset, type ValueState } from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import * as Arr from '@/lib/array-utils'
import * as Color from '@/lib/color'
import type * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import type * as BM from '@/models/battlemetrics.models'
import * as PG from '@/models/player-groupings.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as DndKit from '@/systems/dndkit.client'
import { tr } from '@/systems/messages.client'

type PlayerGroupingsValue = Record<string, PG.Grouping | undefined>

// Drag ids must be unique across every grouping card mounted at once, and a rule has nothing of its own to be named by
// (its position IS its priority), so grouping + index identifies it. JSON-encoded because a grouping id is free text
// and could contain whatever delimiter we picked.
function ruleDragId(groupingId: string, idx: number): string {
	return JSON.stringify([groupingId, idx])
}

function parseRuleDragId(id: string): { groupingId: string; idx: number } {
	const [groupingId, idx] = JSON.parse(id) as [string, number]
	return { groupingId, idx }
}

// A group's color defaults to a reference to the first of its flags that has one, so picking flags is usually all an
// operator has to do and the color keeps tracking battlemetrics afterwards. A group with no flag color to follow gets a
// custom color picked to stand apart from the rest of the grouping. An entry that already exists is left alone.
// Half-finished rules must not leave an entry behind: a placeholder written before a flag is picked (or before the org's
// flags have loaded) would count as existing and block the seeding it is standing in for. A reference to a flag the
// group no longer carries is dropped rather than kept, since the picker would not offer that flag any more.
function syncedGroups(grouping: PG.Grouping, orgFlags: BM.PlayerFlag[] | undefined): Record<string, PG.Group> {
	const groups: Record<string, PG.Group> = {}
	const unassigned: string[] = []
	for (const rule of grouping.rules) {
		if (!rule.group || groups[rule.group] || unassigned.includes(rule.group)) continue
		const existing = grouping.groups?.[rule.group]
		if (existing && (existing.color.type === 'custom' || PG.getGroupFlags(grouping, rule.group).includes(existing.color.flag))) {
			groups[rule.group] = existing
			continue
		}
		const derived = PG.defaultGroupColor(grouping, rule.group, orgFlags)
		if (derived) groups[rule.group] = { color: derived }
		else unassigned.push(rule.group)
	}

	// picked only once every kept color is known, so a new group cannot land next to one that comes after it
	const taken = Object.values(groups).map((g) => PG.resolveGroupColor(g.color, orgFlags))
	for (const group of unassigned) {
		const awaitingFlag = grouping.rules.some((r) => r.type === 'battlemetrics' && r.group === group && (!r.flag || !orgFlags))
		if (awaitingFlag) continue
		const color = Color.pickDistinct(taken)
		taken.push(color)
		groups[group] = { color: { type: 'custom', color } }
	}
	return groups
}

// bespoke editor for `playerGroupings`. Each grouping is an ordered rule list (first match wins), so priority is row
// position rather than a number. Group colors are derived from the rules' flags and kept in a secondary section.
export function PlayerGroupingsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$) as PlayerGroupingsValue) ?? {}
	const groupingIds = Object.keys(value)
	const orgFlags = BattlemetricsClient.useOrgFlags()
	// the union across running servers -- fetched once here rather than per rule row
	const adminGroupsQuery = useQuery(
		RPC.orpc.squadServer.listAdminListGroups.queryOptions({ staleTime: 60_000, select: (res) => RPC.selectLoaded(res) }),
	)
	const adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING = adminGroupsQuery.data
		? adminGroupsQuery.data.map((name) => ({ value: name, label: name }))
		: LOADING

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the group name), where re-emitting would
	// clobber an in-flight keystroke. Structural edits leave it off so inputs re-seed after re-indexing.
	const update = (fn: (v: PlayerGroupingsValue) => PlayerGroupingsValue, quiet?: boolean) => {
		onChange(fn((value$.getValue() as PlayerGroupingsValue) ?? {}))
		if (!quiet) reset$.next()
	}

	// every rule edit re-syncs the group map, so a group can never outlive the last rule naming it
	const updateGrouping = (id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => {
		update((v) => {
			const next = fn(v[id] ?? PG.EMPTY_GROUPING)
			return { ...v, [id]: { ...next, groups: syncedGroups(next, orgFlags) } }
		}, quiet)
	}

	const [newGrouping, setNewGrouping] = React.useState('')
	const trimmedNew = newGrouping.trim()
	const canAdd = trimmedNew.length > 0 && !(trimmedNew in value)
	function addGrouping() {
		if (!canAdd) return
		update((v) => ({ ...v, [trimmedNew]: PG.EMPTY_GROUPING }))
		setNewGrouping('')
	}
	function removeGrouping(id: string) {
		update((v) => {
			const next = { ...v }
			delete next[id]
			return next
		})
	}

	return (
		<div className="space-y-4">
			{groupingIds.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.noGroupings())}</p>}
			{groupingIds.map((id) => (
				<GroupingCard
					key={id}
					groupingId={id}
					grouping={value[id] ?? PG.EMPTY_GROUPING}
					value$={scopeValue(value$, id)}
					reset$={reset$}
					orgFlags={orgFlags}
					adminGroupOptions={adminGroupOptions}
					onUpdate={updateGrouping}
					onRemove={removeGrouping}
				/>
			))}
			<div className="flex max-w-sm items-center gap-2">
				<Input
					placeholder={tr.text(PG_Msgs.newGroupingName())}
					value={newGrouping}
					onChange={(e) => setNewGrouping(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault()
							addGrouping()
						}
					}}
				/>
				<Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={addGrouping}>
					<Icons.Plus className="me-1 h-4 w-4" />
					{tr.text(PG_Msgs.addGrouping())}
				</Button>
			</div>
		</div>
	)
}

// a thin gap between/around rows that highlights while a rule is dragged over it (invisible but layout-occupying otherwise)
function RuleDropSeparator({ position, groupingId, idx }: { position: 'before' | 'after'; groupingId: string; idx: number }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'grouping-rule', id: ruleDragId(groupingId, idx) } }],
	})
	return (
		<li
			ref={drop.ref}
			data-over={drop.isDropTarget}
			className="col-span-full my-0.5 h-1 rounded bg-primary data-[over=false]:invisible"
		/>
	)
}

// sentinel option: leaves the list and lets a name be typed instead
const ADD_NEW_GROUP = '__add-new-group__'

// A rule of the given source with nothing filled in yet, keeping only the group, which every source shares.
function emptyRuleFor(type: PG.GroupRuleSource, group: string): PG.GroupRule {
	switch (type) {
		case 'battlemetrics':
			return { type, flag: '', group }
		case 'admin-list':
			return { type, adminGroup: '', group }
		case 'server-admin':
			return { type, group }
		case 'name-regex':
		case 'tag-regex':
			return { type, pattern: '', group }
		case 'discord-role':
			return { type, roleId: '', group }
		default:
			return assertNever(type)
	}
}

// What a rule matches on, which is the one part of a row that differs per source. `server-admin` has nothing to
// pick: being an admin is the whole condition, so the cell says so rather than showing an empty control.
function RuleValueField({
	rule,
	idx,
	usedFlags,
	usedAdminGroups,
	usedRoleIds,
	adminGroupOptions,
	value$,
	reset$,
	onChange,
}: {
	rule: PG.GroupRule
	idx: number
	usedFlags: string[]
	usedAdminGroups: string[]
	usedRoleIds: string[]
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
}) {
	switch (rule.type) {
		case 'battlemetrics':
			return <BmFlagSelect value={rule.flag || undefined} exclude={usedFlags} onChange={(flag) => onChange(idx, { flag })} />
		case 'admin-list':
			return (
				<ComboBox
					title={tr.text(PG_Msgs.adminGroupPicker())}
					value={rule.adminGroup || undefined}
					options={
						adminGroupOptions === LOADING
							? LOADING
							: adminGroupOptions.filter((o) => o.value === rule.adminGroup || !usedAdminGroups.includes(o.value))
					}
					onSelect={(adminGroup) => {
						if (adminGroup) onChange(idx, { adminGroup })
					}}
				/>
			)
		case 'server-admin':
			return <span className="text-xs text-muted-foreground">{tr.text(PG_Msgs.serverAdminRuleValue())}</span>
		case 'name-regex':
		case 'tag-regex':
			return <RulePatternField rule={rule} idx={idx} value$={value$} reset$={reset$} onChange={onChange} />
		case 'discord-role':
			return (
				<DiscordRoleSelect
					value={rule.roleId}
					onChange={(roleId) => {
						if (!usedRoleIds.includes(roleId) || roleId === rule.roleId) onChange(idx, { roleId })
					}}
				/>
			)
		default:
			return assertNever(rule)
	}
}

// Uncontrolled like the group name beside it, for the same reason: re-emitting on every keystroke would clobber the
// one in flight. The pattern is validated as it is typed rather than only on save, since an invalid one is rejected
// by the schema and would otherwise fail the whole settings write with nothing pointing at this row.
function RulePatternField({
	rule,
	idx,
	value$,
	reset$,
	onChange,
}: {
	rule: Extract<PG.GroupRule, { type: 'name-regex' | 'tag-regex' }>
	idx: number
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
}) {
	const invalid = rule.pattern.trim() !== '' && PG.compilePattern(rule.pattern) === null
	return (
		<div className="min-w-0 space-y-1">
			<TextInputField
				value$={scopeValue(scopeValue(scopeValue(value$, 'rules'), idx), 'pattern')}
				reset$={reset$}
				onChange={(next) => onChange(idx, { pattern: (next as string) ?? '' }, true)}
				numeric={false}
				placeholder={tr.text(rule.type === 'tag-regex' ? PG_Msgs.tagPatternPlaceholder() : PG_Msgs.namePatternPlaceholder())}
			/>
			{invalid && <p className="text-xs text-destructive">{tr.text(PG_Msgs.invalidNamePattern())}</p>}
		</div>
	)
}

function RuleRow({
	rule,
	idx,
	groupingId,
	groupNames,
	groupColors,
	usedFlags,
	usedAdminGroups,
	usedRoleIds,
	adminGroupOptions,
	value$,
	reset$,
	onReplace,
	onChange,
	onRemove,
}: {
	rule: PG.GroupRule
	idx: number
	groupingId: string
	groupNames: string[]
	groupColors: Record<string, string>
	usedFlags: string[]
	usedAdminGroups: string[]
	usedRoleIds: string[]
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	value$: ValueState
	reset$: Rx.Subject<void>
	onReplace: (idx: number, rule: PG.GroupRule) => void
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
	onRemove: () => void
}) {
	const drag = DndKit.useDraggable({ type: 'grouping-rule', id: ruleDragId(groupingId, idx) }, { feedback: 'default' })
	// Several rules feeding one group is the norm, so once the grouping names any group, picking from the list is the
	// common case and typing is the exception. Which mode a row is in has to be sticky, never derived from whether the
	// name exists yet: group names come from the rules themselves, so a half-typed name is already an "existing" group
	// and the field would turn into a combo box under the keystroke that created it.
	const [namingNewGroup, setNamingNewGroup] = React.useState(groupNames.length === 0)
	// only a row the operator switched to naming takes focus, not every fresh row on mount
	const [focusGroupName, setFocusGroupName] = React.useState(false)
	// switching source discards the old source's field: the variants share only `group`, and a stale `flag` sitting on an
	// admin-list rule would be written straight back out again
	function setSource(type: PG.GroupRuleSource) {
		if (type === rule.type) return
		onReplace(idx, emptyRuleFor(type, rule.group))
	}
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="col-span-full grid grid-cols-subgrid items-center rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button
				type="button"
				ref={drag.handleRef}
				className="cursor-grab rounded text-muted-foreground"
				aria-label={tr.text(PG_Msgs.dragToReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
			<Select value={rule.type} onValueChange={(next) => setSource(next as PG.GroupRuleSource)}>
				<SelectTrigger className="h-8" aria-label={tr.text(PG_Msgs.ruleSource())}>
					{/* every label stacked in one cell, so the trigger is as wide as the widest in any locale */}
					<span className="grid">
						{PG.GROUP_RULE_SOURCES.map((source) => (
							<span
								key={source}
								aria-hidden={source !== rule.type}
								className={cn('col-start-1 row-start-1', source !== rule.type && 'invisible')}
							>
								{tr.text(PG_Msgs.groupRuleSourceLabels[source])}
							</span>
						))}
					</span>
				</SelectTrigger>
				<SelectContent>
					{PG.GROUP_RULE_SOURCES.map((source) => (
						<SelectItem key={source} value={source} title={tr.text(PG_Msgs.groupRuleSourceHints[source])}>
							{tr.text(PG_Msgs.groupRuleSourceLabels[source])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<RuleValueField
				rule={rule}
				idx={idx}
				usedFlags={usedFlags}
				usedAdminGroups={usedAdminGroups}
				usedRoleIds={usedRoleIds}
				adminGroupOptions={adminGroupOptions}
				value$={value$}
				reset$={reset$}
				onChange={onChange}
			/>
			<Icons.ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
			{namingNewGroup ? (
				<div className="flex min-w-0 items-center gap-1">
					<TextInputField
						value$={scopeValue(scopeValue(scopeValue(value$, 'rules'), idx), 'group')}
						reset$={reset$}
						onChange={(next) => onChange(idx, { group: (next as string) ?? '' }, true)}
						numeric={false}
						placeholder={tr.text(PG_Msgs.groupNamePlaceholder())}
						autoFocus={focusGroupName}
					/>
					{groupNames.length > 0 && (
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 shrink-0"
							title={tr.text(PG_Msgs.pickExistingGroup())}
							aria-label={tr.text(PG_Msgs.pickExistingGroup())}
							onClick={() => setNamingNewGroup(false)}
						>
							<Icons.List className="h-4 w-4" />
						</Button>
					)}
				</div>
			) : (
				<ComboBox
					title={tr.text(PG_Msgs.groupPicker())}
					value={rule.group || undefined}
					options={[
						...groupNames.map((name): ComboBoxOption<string> => ({
							value: name,
							label: <span style={{ color: groupColors[name] }}>{name}</span>,
						})),
						{
							value: ADD_NEW_GROUP,
							label: <span className="text-muted-foreground">{tr.text(PG_Msgs.addNewGroup())}</span>,
							keywords: ['new'],
						},
					]}
					onSelect={(next) => {
						if (!next) return
						if (next === ADD_NEW_GROUP) {
							setNamingNewGroup(true)
							setFocusGroupName(true)
						} else onChange(idx, { group: next })
					}}
				/>
			)}
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 text-destructive"
				aria-label={tr.text(PG_Msgs.removeRule())}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function GroupingCard({
	groupingId,
	grouping,
	value$,
	reset$,
	orgFlags,
	adminGroupOptions,
	onUpdate,
	onRemove,
}: {
	groupingId: string
	grouping: PG.Grouping
	value$: ValueState
	reset$: Rx.Subject<void>
	orgFlags: BM.PlayerFlag[] | undefined
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	onUpdate: (id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => void
	onRemove: (id: string) => void
}) {
	const rules = grouping.rules ?? []
	// a rule the operator is still filling in names no group yet, and an unnamed color row is just noise
	const groupNames = PG.getGroupNames(grouping).filter(Boolean)
	const groupColors = Object.fromEntries(groupNames.map((name) => [name, PG.getGroupColor(grouping, name, orgFlags)]))

	function changeRule(idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => (i === idx ? ({ ...r, ...patch } as PG.GroupRule) : r)) }), quiet)
	}
	function replaceRule(idx: number, rule: PG.GroupRule) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => (i === idx ? rule : r)) }))
	}
	function addRule() {
		onUpdate(groupingId, (g) => ({ ...g, rules: [...g.rules, { type: 'battlemetrics', flag: '', group: '' }] }))
	}
	function removeRule(idx: number) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.filter((_, i) => i !== idx) }))
	}
	// `quiet` for the custom-color text field only, so an in-flight keystroke is not clobbered
	function setGroupColor(group: string, color: PG.GroupColor, quiet?: boolean) {
		onUpdate(groupingId, (g) => ({ ...g, groups: { ...g.groups, [group]: { color } } }), quiet)
	}

	// drag-to-reorder via the shared dnd-kit provider (see dndkit.client), matching the layer-table column editor. The
	// handler is registered once and reads the latest state off a ref; every grouping card registers one, so a drop
	// belonging to another card's list has to be ignored.
	const stateRef = React.useRef({ groupingId, onUpdate })
	stateRef.current = { groupingId, onUpdate }
	DndKit.useDragEnd(
		React.useCallback((evt) => {
			const { active, over } = evt
			if (active.type !== 'grouping-rule' || !over) return
			const slot = over.slots.find((s) => s.dragItem.type === 'grouping-rule')
			if (!slot) return
			// the separators only ever register before/after; 'on' would mean dropping onto a rule itself, which reorders nothing
			const position = slot.position
			if (position === 'on') return
			const from = parseRuleDragId(active.id)
			// find() can't narrow the element, so the id is still the union's string | number here
			const to = parseRuleDragId(String(slot.dragItem.id))
			const { groupingId, onUpdate } = stateRef.current
			if (from.groupingId !== groupingId || to.groupingId !== groupingId) return
			onUpdate(groupingId, (g) => ({ ...g, rules: Arr.moveItem(g.rules, from.idx, to.idx, position) }))
		}, []),
	)

	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium">{groupingId}</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6 shrink-0 text-destructive"
					aria-label={tr.text(PG_Msgs.removeGrouping(groupingId))}
					onClick={() => onRemove(groupingId)}
				>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>

			<div className="space-y-1.5">
				<Label className="text-xs text-muted-foreground">{tr.text(PG_Msgs.rules())}</Label>
				<p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.rulesBlurb())}</p>
				{rules.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.noRules())}</p>}
				{rules.length > 0 && (
					// the headers and every rule row are subgrids of this one, so the `auto` source column fits its widest label
					<div className="grid grid-cols-[auto_1.5rem_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-x-2">
						<div className="col-span-full grid grid-cols-subgrid items-center text-xs font-medium text-muted-foreground">
							<span />
							<span />
							<span />
							<span>{tr.text(PG_Msgs.matchesColumn())}</span>
							<span />
							<span>{tr.text(PG_Msgs.groupColumn())}</span>
							<span />
						</div>
						<ol className="col-span-full grid grid-cols-subgrid">
							{rules.map((rule, idx) => (
								// oxlint-disable-next-line no-array-index-key
								<React.Fragment key={idx}>
									<RuleDropSeparator position="before" groupingId={groupingId} idx={idx} />
									<RuleRow
										rule={rule}
										idx={idx}
										groupingId={groupingId}
										groupNames={groupNames}
										groupColors={groupColors}
										usedFlags={rules.flatMap((r) => (r.type === 'battlemetrics' ? [r.flag] : []))}
										usedAdminGroups={rules.flatMap((r) => (r.type === 'admin-list' ? [r.adminGroup] : []))}
										usedRoleIds={rules.flatMap((r) => (r.type === 'discord-role' ? [r.roleId] : []))}
										adminGroupOptions={adminGroupOptions}
										value$={value$}
										reset$={reset$}
										onReplace={replaceRule}
										onChange={changeRule}
										onRemove={() => removeRule(idx)}
									/>
								</React.Fragment>
							))}
							<RuleDropSeparator position="after" groupingId={groupingId} idx={rules.length - 1} />
						</ol>
					</div>
				)}
				<Button type="button" variant="outline" size="sm" onClick={addRule}>
					<Icons.Plus className="me-1 h-4 w-4" />
					{tr.text(PG_Msgs.addRule())}
				</Button>
			</div>

			{groupNames.length > 0 && (
				<details>
					<summary className="cursor-pointer text-xs text-muted-foreground">
						{tr.text(PG_Msgs.colorsSummary(groupNames.length))}
					</summary>
					<p className="mt-1 text-xs text-muted-foreground">{tr.text(PG_Msgs.colorsBlurb())}</p>
					<ul className="mt-1.5 space-y-1">
						{groupNames.map((group) => (
							<GroupColorRow
								key={group}
								group={group}
								grouping={grouping}
								orgFlags={orgFlags}
								value$={value$}
								reset$={reset$}
								onSetColor={setGroupColor}
							/>
						))}
					</ul>
				</details>
			)}
		</div>
	)
}

// One group's color: the swatch and the hex code are the same control, and the flag it follows sits after them. The
// hex field always shows the color in effect, flag-derived or not, so editing it is how a group stops tracking.
function GroupColorRow({
	group,
	grouping,
	orgFlags,
	value$,
	reset$,
	onSetColor,
}: {
	group: string
	grouping: PG.Grouping
	orgFlags: BM.PlayerFlag[] | undefined
	value$: ValueState
	reset$: Rx.Subject<void>
	onSetColor: (group: string, color: PG.GroupColor, quiet?: boolean) => void
}) {
	const hexRef = React.useRef<HTMLInputElement>(null)
	const color = grouping.groups?.[group]?.color
	const resolved = PG.getGroupColor(grouping, group, orgFlags)
	const flags = PG.getGroupFlags(grouping, group)

	const seedHex = (hex: string) => {
		if (hexRef.current && hexRef.current.value !== hex) hexRef.current.value = hex
	}
	// the pulse lands before React re-renders, so the new color has to be read off value$ rather than the props. A
	// group the edit removed is gone from it, and has no color left to show.
	useReset(reset$, () => {
		const current = value$.getValue() as PG.Grouping | undefined
		if (current?.groups?.[group]) seedHex(PG.getGroupColor(current, group, orgFlags))
	})

	// `quiet` so a keystroke is not clobbered mid-edit, which also means an edit from anywhere else has to write the
	// uncontrolled input back by hand
	const setCustom = (hex: string, fromHexField?: boolean) => {
		if (!fromHexField) seedHex(hex)
		onSetColor(group, { type: 'custom', color: hex }, true)
	}

	return (
		<li className="grid grid-cols-[minmax(0,8rem)_auto_minmax(0,1fr)] items-center gap-2">
			<span className="min-w-0 truncate text-xs" title={group}>
				{group}
			</span>
			<InputGroup className="h-8 w-[9.5rem]">
				<InputGroupAddon align="inline-start">
					<Popover>
						<PopoverTrigger asChild>
							<InputGroupButton size="icon-xs" title={tr.text(PG_Msgs.pickColor())} aria-label={tr.text(PG_Msgs.pickColor())}>
								<span className="size-4 rounded-sm border" style={{ backgroundColor: resolved }} />
							</InputGroupButton>
						</PopoverTrigger>
						<PopoverContent className="w-auto p-2">
							<ColorPicker color={resolved} onChange={(c) => setCustom(c)} />
						</PopoverContent>
					</Popover>
				</InputGroupAddon>
				{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
				<input
					ref={hexRef}
					data-slot="input-group-control"
					defaultValue={resolved}
					maxLength={7}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setCustom(e.currentTarget.value.trim(), true)}
					className="w-full min-w-0 bg-transparent py-1 pe-2 font-mono text-xs outline-none ltr-isolate"
				/>
			</InputGroup>
			{flags.length > 0 && (
				<span className="flex min-w-0 items-center gap-2">
					<span className="shrink-0 text-xs text-muted-foreground">{tr.text(PG_Msgs.trackingFlag())}</span>
					<BmFlagSelect
						title={tr.text(PG_Msgs.colorFromFlag())}
						placeholder={tr.text(PG_Msgs.trackNoFlag())}
						value={color?.type === 'flag' ? color.flag : undefined}
						only={flags}
						onChange={(flag) => onSetColor(group, { type: 'flag', flag })}
					/>
				</span>
			)}
		</li>
	)
}
