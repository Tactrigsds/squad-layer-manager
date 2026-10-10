import * as Icons from 'lucide-react'
import React from 'react'

import { BmFlagMultiSelect } from '@/components/bm-flag-picker'
import ComboBox from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import LayerGenerationConfigEditor from '@/components/layer-generation-config-editor'
import LayerTableConfigEditor from '@/components/layer-table-config-editor'
import { PoolFiltersPanel, RepeatRulesPanel } from '@/components/pool-config-panels'
import type { PoolConfigApi } from '@/components/pool-config-panels.helpers'
import { TextInputField } from '@/components/settings-form/controls'
import {
	DEBOUNCE_MS,
	getAtPath,
	type OverrideProps,
	setAtPath,
	useFieldValue,
	useReset,
} from '@/components/settings-form/settings-form.helpers'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { useDebounced } from '@/hooks/use-debounce'
import { createId } from '@/lib/id'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as LC from '@/models/layer-columns.models'
import * as L from '@/models/layer.models'
import * as ConfigClient from '@/systems/config.client'
import * as MessagesClient from '@/systems/messages.client'
import { tr } from '@/systems/messages.client'

export function FlagMultiSelectField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$)
	return <BmFlagMultiSelect value={value ?? []} onChange={onChange} />
}

// The languages this build ships a catalogue for. A stored tag this build no longer carries stays in the list, so
// the setting shows what it actually holds rather than reading as unset; the runtime already falls back to English
// for it. Each language is named in itself, which is what someone who cannot read the current one needs.
export function LocaleField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	const available = MessagesClient.availableLocales()
	const tags = value && !available.includes(value) ? [...available, value] : available
	return (
		<ComboBox
			className="w-min"
			title={tr.text(SETTINGS_Msgs.localePicker())}
			allowEmpty={false}
			value={value}
			options={tags.map((tag) => ({ value: tag, label: MessagesClient.endonym(tag), keywords: [tag] }))}
			onSelect={(tag) => tag !== undefined && onChange(tag)}
		/>
	)
}

export function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<TextInputField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			numeric={false}
			secret
			placeholder={tr.text(SETTINGS_Msgs.passwordPlaceholder())}
		/>
	)
}

// the server-agent's shared secret: masked by default, with generate-a-new-token and copy-to-clipboard affordances. The
// input is uncontrolled (seeded from value$, debounced upward, re-read on reset$), same as TextInputField.
export function ServerAgentTokenField({ value$, reset$, onChange }: OverrideProps) {
	const ref = React.useRef<HTMLInputElement>(null)
	const [show, setShow] = React.useState(false)
	const [copied, setCopied] = React.useState(false)
	const copiedTimeout = React.useRef<ReturnType<typeof setTimeout>>(null)
	const push = useDebounced<any>({ delay: DEBOUNCE_MS, onChange })
	const repoUrl = Zus.useStore(ConfigClient.Store, (s) => s?.repoUrl)
	const docUrl = repoUrl ? `${repoUrl}/blob/HEAD/docs/guide/operations/server_agent.md` : undefined
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) ref.current.value = formatted
	})

	function generate() {
		const token = createId(32)
		if (ref.current) ref.current.value = token
		setShow(true)
		onChange(token)
	}
	function copy() {
		const cur = ref.current?.value ?? ''
		if (!cur) return
		void navigator.clipboard.writeText(cur)
		setCopied(true)
		if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
		copiedTimeout.current = setTimeout(() => setCopied(false), 1500)
	}
	React.useEffect(
		() => () => {
			if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
		},
		[],
	)

	return (
		<div className="space-y-1.5">
			<InputGroup>
				{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
				<input
					ref={ref}
					data-slot="input-group-control"
					type={show ? 'text' : 'password'}
					defaultValue={format(value$.getValue())}
					placeholder={tr.text(SETTINGS_Msgs.serverAgentTokenPlaceholder())}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => push(e.currentTarget.value)}
					className="flex-1 min-w-0 bg-transparent px-3 py-1 font-mono text-sm outline-none placeholder:text-muted-foreground placeholder:font-sans ltr-isolate"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						size="icon-xs"
						aria-label={show ? tr.text(SETTINGS_Msgs.hideToken()) : tr.text(SETTINGS_Msgs.showToken())}
						onClick={() => setShow((s) => !s)}
					>
						{show ? <Icons.EyeOff /> : <Icons.Eye />}
					</InputGroupButton>
					<InputGroupButton size="icon-xs" aria-label={tr.text(SETTINGS_Msgs.copyToken())} onClick={copy}>
						{copied ? <Icons.Check /> : <Icons.Copy />}
					</InputGroupButton>
					<InputGroupButton size="xs" onClick={generate}>
						<Icons.RefreshCw />
						{tr.text(SETTINGS_Msgs.generateToken())}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			<p className="text-xs text-muted-foreground">
				{tr.text(SETTINGS_Msgs.serverAgentTokenBlurb())}{' '}
				{docUrl && (
					<a href={docUrl} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
						{tr.text(SETTINGS_Msgs.serverAgentSetupGuide())}
					</a>
				)}
			</p>
		</div>
	)
}

// bespoke editor for the layer-table config (column order/visibility, default sort, extra menu items, default filters)
export function LayerTableField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$)
	return (
		<LayerTableConfigEditor
			value={value ?? { orderedColumns: [], defaultSortBy: { type: 'random' } }}
			onChange={onChange}
			reset$={reset$}
		/>
	)
}

// bespoke editor for the weighted-random layer generation config (pick order + per-value / per-matchup weights)
export function LayerGenerationField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$)
	return <LayerGenerationConfigEditor value={value ?? LC.LayerGenerationConfigSchema.parse({})} onChange={onChange} reset$={reset$} />
}

// PoolConfigApi over the form's draft observable, so the settings page renders the same pool-configuration UI as the
// dashboard popover. Paths are relative to the pool object this override is mounted on (queue.mainPool).
function usePoolConfigApi({ value$, reset$, onChange }: OverrideProps): PoolConfigApi {
	const [resetKey, setResetKey] = React.useState(0)
	useReset(reset$, () => setResetKey((k) => k + 1))
	return {
		source: value$,
		read: (root, path) => getAtPath(root, path),
		getValue: (path) => getAtPath(value$.getValue(), path),
		set: (path, value) => onChange(setAtPath(value$.getValue(), path, value)),
		// the settings page gates edit access via the server-settings:* perms; out-of-grant writes are rejected server-side
		writeDenied: null,
		resetKey,
	}
}

// The collections the catalog knows, offered as a multi-select. A value the catalog no longer carries stays
// selectable so an unrecognised entry is visible rather than silently dropped on the next save.
export function InstalledModsField({ value$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$) as string[] | undefined) ?? []
	const collections = L.StaticLayerComponents.collections
	const options = [...new Set([...collections, ...value])].map((collection) => ({
		value: collection,
		label: collections.includes(collection) ? collection : tr.text(SETTINGS_Msgs.unknownCollection(collection)),
	}))

	return (
		<div className="max-w-[28rem]">
			<ComboBoxMulti
				title={tr.text(SETTINGS_Msgs.installedModsPicker())}
				values={value}
				options={options}
				emptyLabel={tr.text(SETTINGS_Msgs.selectInstalledMods())}
				chipDisplay
				onSelect={(next) => onChange(typeof next === 'function' ? next(value) : next)}
			/>
		</div>
	)
}

export function MainPoolField(props: OverrideProps) {
	const api = usePoolConfigApi(props)
	return (
		<div className="space-y-6">
			<PoolFiltersPanel api={api} />
			<RepeatRulesPanel api={api} />
		</div>
	)
}
