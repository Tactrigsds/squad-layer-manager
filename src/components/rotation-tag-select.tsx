import ComboBox, { type ComboBoxOption } from '@/components/combo-box/combo-box.tsx'
import { UnresolvedLabel, UnresolvedNote } from '@/components/unresolved-label'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import type * as LTag from '@/models/layer-tags.models'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

const NO_TAGS: LTag.Tag[] = []

// A picker over the rotation tags configured in the global settings, which every signed-in client already holds. A
// stored id that names no tag is kept as an option, so the value survives being looked at, and reads as gone.
export function RotationTagSelect(props: {
	value: string | null
	onChange: (value: string | null) => void
	disabled?: boolean
	className?: string
	title?: string
}) {
	const tags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.rotationTags) ?? NO_TAGS
	const unresolved = !!props.value && !tags.some((tag) => tag.id === props.value)
	const options = tags.map((tag): ComboBoxOption<string> => ({
		value: tag.id,
		label: (
			<span className="inline-flex min-w-0 items-center gap-1.5">
				<span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: tag.color }} />
				<span className="truncate">{tag.label}</span>
			</span>
		),
		keywords: [tag.label],
	}))
	if (unresolved) options.push({ value: props.value!, label: <UnresolvedLabel id={props.value!} />, keywords: [props.value!] })
	return (
		<>
			<ComboBox
				className={props.className}
				title={props.title ?? tr.text(SETTINGS_Msgs.rotationTagPicker())}
				value={props.value ?? undefined}
				options={options}
				disabled={props.disabled}
				onSelect={(id) => props.onChange(id ?? null)}
			/>
			{unresolved && <UnresolvedNote>{tr.text(SETTINGS_Msgs.rotationTagUnresolved())}</UnresolvedNote>}
		</>
	)
}
