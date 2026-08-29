import { useQuery } from '@tanstack/react-query'
import React from 'react'

import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants'
import type { ComboBoxGroupingDef } from '@/components/combo-box/options'
import { UnresolvedLabel, UnresolvedNote } from '@/components/unresolved-label'
import { useDebounced } from '@/hooks/use-debounce'
import * as USR_Msgs from '@/messages/users.messages'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as UsersClient from '@/systems/users.client'

// -------- Discord role picker (bounded list, filtered client-side) --------

function useGuildRoles(): { roles: { id: string; name: string; color: string | null }[]; isResolved: boolean } {
	const { data } = useQuery(RPC.orpc.rbac.listGuildRoles.queryOptions({ staleTime: Infinity }))
	const ok = data?.code === 'ok'
	// isResolved only once we have the authoritative role list, so a still-loading (or denied) fetch never mislabels a
	// valid role as deleted
	return { roles: ok ? data.roles : [], isResolved: ok }
}

function RoleLabel({ role }: { role: { name: string; color: string | null } }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="h-2.5 w-2.5 rounded-full shrink-0 border" style={{ backgroundColor: role.color ?? 'transparent' }} />
			{role.name}
		</span>
	)
}

export function DiscordRoleSelect({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
	const { roles, isResolved } = useGuildRoles()
	const options: ComboBoxOption<string>[] = roles.map((r) => ({ value: r.id, label: <RoleLabel role={r} />, keywords: [r.name] }))
	// stored role id that isn't among the guild's current roles -> it was deleted
	const unresolved = !!value && isResolved && !roles.some((r) => r.id === value)
	if (unresolved) options.unshift({ value, label: <UnresolvedLabel id={value} />, keywords: [value] })
	return (
		<div className="space-y-1">
			<ComboBox
				className="w-full"
				title={tr.text(USR_Msgs.discordRolePicker())}
				value={value || undefined}
				options={options}
				disabled={disabled}
				onSelect={(id) => {
					if (id) onChange(id)
				}}
			/>
			{unresolved && <UnresolvedNote>{tr.text(USR_Msgs.discordRoleUnresolved())}</UnresolvedNote>}
		</div>
	)
}

// -------- Discord member picker (server-side search across all guild members) --------

const NUMERIC_ID = /^\d+$/

function MemberLabel({ member }: { member: { displayName: string; username: string } }) {
	return (
		<span className="inline-flex items-center gap-1.5 min-w-0">
			<span className="truncate">{member.displayName}</span>
			<span className="text-muted-foreground truncate">@{member.username}</span>
		</span>
	)
}

export function DiscordMemberSelect({
	value,
	onChange,
	disabled,
}: {
	value: string
	onChange: (next: string) => void
	disabled?: boolean
}) {
	const [input, setInput] = React.useState('')
	const [queryTerm, setQueryTerm] = React.useState('')
	const setDebouncedQuery = useDebounced<string>({ delay: 250, onChange: setQueryTerm })

	const searchRes = useQuery(
		RPC.orpc.rbac.searchGuildMembers.queryOptions({
			input: { query: queryTerm },
			enabled: queryTerm.trim().length > 0,
			staleTime: 60_000,
		}),
	)
	const results = searchRes.data && searchRes.data.code === 'ok' ? searchRes.data.members : []

	// resolve a label for the currently-selected id if it isn't in the current search results (known SLM users only)
	const canResolve = !!value && NUMERIC_ID.test(value)
	const usersRes = UsersClient.useUsers(canResolve ? [BigInt(value)] : [], { enabled: canResolve })
	const knownUser = usersRes.data?.code === 'ok' ? usersRes.data.users.find((u) => String(u.discordId) === value) : undefined

	const inResults = results.find((m) => m.id === value)
	// value set, resolution has settled, and we still can't put a name to it -> not a current member / unknown user
	const resolved = usersRes.isSuccess || usersRes.isError
	const unresolved = !!value && !inResults && !knownUser && resolved

	function selectedLabel(): React.ReactNode {
		if (inResults) return <MemberLabel member={inResults} />
		if (knownUser) return knownUser.displayName
		if (unresolved) return <UnresolvedLabel id={value} />
		return value
	}

	const options: ComboBoxOption<string>[] = [
		...(value ? [{ value, label: selectedLabel(), keywords: [value] }] : []),
		...results
			.filter((m) => m.id !== value)
			.map((m): ComboBoxOption<string> => ({
				value: m.id,
				label: <MemberLabel member={m} />,
				keywords: [m.displayName, m.username],
			})),
	]

	// before any query is typed there's nothing to show, so the picker would otherwise read "No member found." as if it
	// had searched and come up empty. Show a spinner while a search is in flight, a prompt when idle, and only the real
	// "not found" once a query has actually settled with no matches.
	const hasQuery = queryTerm.trim().length > 0
	const searching = hasQuery && searchRes.isFetching
	const comboOptions = searching && options.length === 0 ? LOADING : options
	const emptyMessage = hasQuery ? tr.text(USR_Msgs.noDiscordMembersFound()) : tr.text(USR_Msgs.searchDiscordMembers())

	return (
		<div className="space-y-1">
			<ComboBox
				className="w-full"
				title={tr.text(USR_Msgs.discordMemberPicker())}
				placeholder={tr.text(USR_Msgs.discordMemberPlaceholder())}
				searchPlaceholder={tr.text(USR_Msgs.discordMemberSearchPlaceholder())}
				emptyMessage={emptyMessage}
				value={value || undefined}
				options={comboOptions}
				disabled={disabled}
				inputValue={input}
				setInputValue={(v) => {
					setInput(v)
					setDebouncedQuery(v)
				}}
				onSelect={(id) => {
					if (id) onChange(id)
				}}
			/>
			{unresolved && <UnresolvedNote>{tr.text(USR_Msgs.discordMemberUnresolved())}</UnresolvedNote>}
		</div>
	)
}

// -------- Discord channel pickers (bounded list, grouped by category) --------

function useGuildChannels(): { channels: { id: string; name: string; categoryName: string | null }[]; isResolved: boolean } {
	const { data } = useQuery(RPC.orpc.rbac.listGuildChannels.queryOptions({ staleTime: Infinity }))
	const ok = data?.code === 'ok'
	// only once the authoritative list is in, so a still-loading or denied fetch never mislabels a live
	// channel as deleted
	return { channels: ok ? data.channels : [], isResolved: ok }
}

const UNCATEGORIZED = 'Uncategorized'

// the category each channel sits under, which the combo box narrows by once two are live. Built from the
// fetched list rather than declared: the categories are whatever the guild has.
function channelGroupings(channels: { categoryName: string | null }[]): ComboBoxGroupingDef[] {
	const groups = [...new Set(channels.map((c) => c.categoryName ?? UNCATEGORIZED))]
	return groups.length > 1 ? [{ key: 'category', label: 'Category', groups }] : []
}

function channelOptions(
	channels: { id: string; name: string; categoryName: string | null }[],
	selected: string[],
	isResolved: boolean,
): ComboBoxOption<string>[] {
	const known: ComboBoxOption<string>[] = channels.map((c) => ({
		value: c.id,
		label: `#${c.name}`,
		keywords: [c.name, c.categoryName ?? UNCATEGORIZED],
		groups: { category: c.categoryName ?? UNCATEGORIZED },
	}))
	const unknown = selected
		.filter((id) => isResolved && !channels.some((c) => c.id === id))
		.map((id): ComboBoxOption<string> => ({ value: id, label: <UnresolvedLabel id={id} />, keywords: [id] }))
	return [...unknown, ...known]
}

export function DiscordChannelSelect(props: {
	value: string | null
	onChange: (value: string | null) => void
	disabled?: boolean
	className?: string
	title?: string
}) {
	const { channels, isResolved } = useGuildChannels()
	const value = props.value ?? ''
	const unresolved = !!value && isResolved && !channels.some((c) => c.id === value)
	return (
		<div className="space-y-1">
			<ComboBox
				className={props.className ?? 'w-full'}
				title={props.title ?? tr.text(USR_Msgs.discordChannelPicker())}
				value={value || undefined}
				options={channelOptions(channels, value ? [value] : [], isResolved)}
				groupings={channelGroupings(channels)}
				disabled={props.disabled}
				onSelect={(id) => props.onChange(id ?? null)}
			/>
			{unresolved && <UnresolvedNote>{tr.text(USR_Msgs.discordChannelUnresolved())}</UnresolvedNote>}
		</div>
	)
}

export function DiscordChannelMultiSelect(props: {
	values: string[]
	onChange: (values: string[]) => void
	selectionLimit?: number
	disabled?: boolean
	className?: string
	title?: string
}) {
	const { channels, isResolved } = useGuildChannels()
	const unresolved = isResolved && props.values.some((id) => !channels.some((c) => c.id === id))
	return (
		<div className="space-y-1">
			<ComboBoxMulti
				className={props.className ?? 'w-full'}
				title={props.title ?? tr.text(USR_Msgs.discordChannelPickerMulti())}
				values={props.values}
				options={channelOptions(channels, props.values, isResolved)}
				groupings={channelGroupings(channels)}
				selectionLimit={props.selectionLimit}
				disabled={props.disabled}
				chipDisplay
				onSelect={(next) => props.onChange(typeof next === 'function' ? next(props.values) : next)}
			/>
			{unresolved && <UnresolvedNote>{tr.text(USR_Msgs.discordChannelUnresolved())}</UnresolvedNote>}
		</div>
	)
}
