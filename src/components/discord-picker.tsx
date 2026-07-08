import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import { useDebounced } from '@/hooks/use-debounce'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import React from 'react'

// -------- Discord role picker (bounded list, filtered client-side) --------

function useGuildRoles(): { id: string; name: string; color: string | null }[] {
	const { data } = useQuery(RPC.orpc.rbac.listGuildRoles.queryOptions({ staleTime: Infinity }))
	return data && data.code === 'ok' ? data.roles : []
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
	const roles = useGuildRoles()
	const options: ComboBoxOption<string>[] = roles.map((r) => ({ value: r.id, label: <RoleLabel role={r} />, keywords: [r.name] }))
	return (
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

	function selectedLabel(): React.ReactNode {
		const inResults = results.find((m) => m.id === value)
		if (inResults) return <MemberLabel member={inResults} />
		if (knownUser) return knownUser.displayName
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

	return (
		<ComboBox
			className="w-full"
			title="member"
			placeholder="Search members…"
			value={value || undefined}
			options={options}
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
	)
}
