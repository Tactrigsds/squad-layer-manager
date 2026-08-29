import ComboBoxMulti from '@/components/combo-box/combo-box-multi.tsx'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { serverOptionsFor } from '@/components/server-select.helpers.ts'
import { UnresolvedLabel, UnresolvedNote } from '@/components/unresolved-label'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

// Pickers over the managed servers. Options come from the public settings, which every signed-in client
// already holds, so neither of these fetches anything.

function useServers() {
	return Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []
}

// serverOptionsFor keeps a stored id that names no live server, so the value survives being looked at. Here it
// also has to read as gone: a bare id in a list of names is indistinguishable from a server nobody named yet.
function optionsFor(servers: { id: string; displayName: string }[], selected: string[]) {
	return serverOptionsFor(servers, selected).map((option) =>
		option.label === undefined ? { ...option, label: <UnresolvedLabel id={option.value} /> } : option,
	)
}

function unresolvedIds(servers: { id: string }[], selected: string[]): string[] {
	return selected.filter((id) => !servers.some((s) => s.id === id))
}

export function ServerSelect(props: {
	value: string | null
	onChange: (value: string | null) => void
	disabled?: boolean
	className?: string
	title?: string
}) {
	const servers = useServers()
	const selected = props.value ? [props.value] : []
	const unresolved = unresolvedIds(servers, selected)
	return (
		<>
			<ComboBox
				className={props.className}
				title={props.title ?? 'Server'}
				value={props.value ?? undefined}
				options={optionsFor(servers, selected)}
				disabled={props.disabled}
				onSelect={(id) => props.onChange(id ?? null)}
			/>
			{unresolved.length > 0 && <UnresolvedNote>{tr.text(SETTINGS_Msgs.serverUnresolved(unresolved.length))}</UnresolvedNote>}
		</>
	)
}

export function ServerMultiSelect(props: {
	values: string[]
	onChange: (values: string[]) => void
	selectionLimit?: number
	disabled?: boolean
	className?: string
	title?: string
}) {
	const servers = useServers()
	const unresolved = unresolvedIds(servers, props.values)
	return (
		<>
			<ComboBoxMulti
				className={props.className}
				title={props.title ?? 'Servers'}
				values={props.values}
				options={optionsFor(servers, props.values)}
				selectionLimit={props.selectionLimit}
				disabled={props.disabled}
				chipDisplay
				onSelect={(next) => props.onChange(typeof next === 'function' ? next(props.values) : next)}
			/>
			{unresolved.length > 0 && <UnresolvedNote>{tr.text(SETTINGS_Msgs.serverUnresolved(unresolved.length))}</UnresolvedNote>}
		</>
	)
}
