import ComboBoxMulti from '@/components/combo-box/combo-box-multi.tsx'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { serverOptionsFor } from '@/components/server-select.helpers.ts'
import * as Zus from '@/lib/zustand'
import * as SettingsClient from '@/systems/settings.client'

// Pickers over the managed servers. Options come from the public settings, which every signed-in client
// already holds, so neither of these fetches anything.

function useServers() {
	return Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []
}

export function ServerSelect(props: {
	value: string | null
	onChange: (value: string | null) => void
	disabled?: boolean
	className?: string
	title?: string
}) {
	const servers = useServers()
	return (
		<ComboBox
			className={props.className}
			title={props.title ?? 'Server'}
			value={props.value ?? undefined}
			options={serverOptionsFor(servers, props.value ? [props.value] : [])}
			disabled={props.disabled}
			onSelect={(id) => props.onChange(id ?? null)}
		/>
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
	return (
		<ComboBoxMulti
			className={props.className}
			title={props.title ?? 'Servers'}
			values={props.values}
			options={serverOptionsFor(servers, props.values)}
			selectionLimit={props.selectionLimit}
			disabled={props.disabled}
			chipDisplay
			onSelect={(next) => props.onChange(typeof next === 'function' ? next(props.values) : next)}
		/>
	)
}
