import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import { LOADING } from '@/components/combo-box/constants'
import { useDebounced } from '@/hooks/use-debounce'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

// a stored id that no longer resolves to a live Discord role/member (deleted role, departed member): surface the raw
// id with a warning rather than a confusing blank, and explain the situation below the picker
function UnresolvedLabel({ id }: { id: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-500">
			<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
			<span className="font-mono">{id}</span>
		</span>
	)
}

function UnresolvedNote({ children }: { children: React.ReactNode }) {
	return <p className="text-xs text-amber-600 dark:text-amber-500">{children}</p>
}

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

export function DiscordRoleSelect(
	{ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean },
) {
	const { roles, isResolved } = useGuildRoles()
	const options: ComboBoxOption<string>[] = roles.map((r) => ({ value: r.id, label: <RoleLabel role={r} />, keywords: [r.name] }))
	// stored role id that isn't among the guild's current roles -> it was deleted
	const unresolved = !!value && isResolved && !roles.some((r) => r.id === value)
	if (unresolved) options.unshift({ value, label: <UnresolvedLabel id={value} />, keywords: [value] })
	return (
		<div className="space-y-1">
			<ComboBox
				className="w-full"
				title="role"
				value={value || undefined}
				options={options}
				disabled={disabled}
				onSelect={(id) => {
					if (id) onChange(id)
				}}
			/>
			{unresolved && (
				<UnresolvedNote>
					This Discord role no longer exists in the server (its id is shown). Pick another role or remove this assignment.
				</UnresolvedNote>
			)}
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

export function DiscordMemberSelect(
	{ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean },
) {
	const [input, setInput] = React.useState('')
	const [queryTerm, setQueryTerm] = React.useState('')
	const setDebouncedQuery = useDebounced<string>({ delay: 250, onChange: setQueryTerm })

	const searchRes = useQuery(RPC.orpc.rbac.searchGuildMembers.queryOptions({
		input: { query: queryTerm },
		enabled: queryTerm.trim().length > 0,
		staleTime: 60_000,
	}))
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
		...results.filter((m) => m.id !== value).map((m): ComboBoxOption<string> => ({
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
	const emptyMessage = hasQuery ? 'No members found.' : 'Type a name or id to search members.'

	return (
		<div className="space-y-1">
			<ComboBox
				className="w-full"
				title="member"
				placeholder="Search members…"
				searchPlaceholder="Search by name or id…"
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
			{unresolved && (
				<UnresolvedNote>
					This Discord user isn't a current server member (their id is shown). They may have left the server, or are otherwise unknown.
				</UnresolvedNote>
			)}
		</div>
	)
}
