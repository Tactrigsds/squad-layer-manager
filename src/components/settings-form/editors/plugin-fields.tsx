// Controls a schema asks for by name. The other overrides are chosen by setting path (see overrides.ts), which a
// plugin's config has no way to reach. A plugin declares the control it wants in its schema instead (see Fields in
// models/plugins.models), and it arrives here as a JSON Schema key.

import React from 'react'

import { DiscordChannelMultiSelect, DiscordChannelSelect } from '@/components/discord-picker'
import { FilterMultiSelect, FilterSelect } from '@/components/filter-entity-select'
import { ServerMultiSelect, ServerSelect } from '@/components/server-select'
import { DEBOUNCE_MS, type OverrideProps, useFieldValue, useReset } from '@/components/settings-form/settings-form.helpers'
import { Textarea } from '@/components/ui/textarea'
import { useDebounced } from '@/hooks/use-debounce'

export function PluginFilterField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <FilterSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

export function PluginFilterMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <FilterMultiSelect values={value ?? []} onChange={onChange} />
}

export function PluginServerField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <ServerSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

export function PluginServerMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <ServerMultiSelect values={value ?? []} onChange={onChange} />
}

export function PluginChannelField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <DiscordChannelSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

export function PluginChannelMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <DiscordChannelMultiSelect values={value ?? []} onChange={onChange} />
}

// uncontrolled and debounced like TextInputField; a template is long enough that a one-line input hides most
// of what has been written
export function PluginMultilineField({ value$, reset$, onChange }: OverrideProps) {
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
			rows={3}
			className="resize-y"
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}
