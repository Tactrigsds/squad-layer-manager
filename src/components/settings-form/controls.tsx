import * as Icons from 'lucide-react'
import React from 'react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import {
	DEBOUNCE_MS,
	emptyValue,
	type NormalizedIssue,
	type SchemaNode,
	useFieldValue,
	useReset,
	type ValueState,
} from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import type * as Rx from '@/lib/rxjs'
import * as SettingsNav from '@/lib/settings-nav'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { tr } from '@/systems/messages.client'

const MAX_SHOWN_FIELD_ISSUES = 5

export function FieldIssues({ issues, pathStr }: { issues: NormalizedIssue[]; pathStr: string }) {
	if (issues.length === 0) return null
	return (
		<div className="space-y-0.5 pt-0.5">
			{issues.slice(0, MAX_SHOWN_FIELD_ISSUES).map((iss, i) => (
				// oxlint-disable-next-line no-array-index-key
				<p key={i} className="flex items-start gap-1 text-xs font-medium text-destructive">
					<Icons.CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
					<span className="min-w-0 wrap-break-word">
						{iss.path !== pathStr && (
							<code className="me-1 text-[10px] opacity-70 ltr-isolate">{iss.path.slice(pathStr.length + 1)}</code>
						)}
						{iss.message}
					</span>
				</p>
			))}
			{issues.length > MAX_SHOWN_FIELD_ISSUES && (
				<p className="text-xs text-destructive/80">{tr.text(SETTINGS_Msgs.moreIssues(issues.length - MAX_SHOWN_FIELD_ISSUES))}</p>
			)}
		</div>
	)
}

// a small "?" affordance that reveals a longer explanation on hover, so compact editors can drop verbose inline
// descriptions. `links` render as buttons that jump to (and highlight) another setting by its anchor id.
export function HelpTip({ text, links }: { text: string; links?: { label: string; anchor: string }[] }) {
	return (
		<Tooltip pinnable>
			<TooltipTrigger asChild>
				<button type="button" className="text-muted-foreground hover:text-foreground" aria-label={tr.text(SETTINGS_Msgs.help())}>
					<Icons.CircleHelp className="h-3.5 w-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-1.5">
				<p>{text}</p>
				{links && links.length > 0 && (
					<div className="flex flex-wrap gap-x-3 gap-y-1">
						{links.map((link) => (
							<button
								key={link.anchor}
								type="button"
								className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
								onClick={() => SettingsNav.navigateToAnchor(link.anchor)}
							>
								<Icons.ArrowRight className="h-3 w-3 shrink-0 rtl:-scale-x-100" />
								{link.label}
							</button>
						))}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	)
}

// uncontrolled text/number input: seeded from value$, edits debounced upward, re-read on reset$
export function TextInputField({
	value$,
	reset$,
	onChange,
	numeric,
	secret,
	placeholder,
	autoFocus,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	numeric: boolean
	secret?: boolean
	placeholder?: string
	autoFocus?: boolean
}) {
	const ref = React.useRef<HTMLInputElement>(null)
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
	const push = useDebounced<any>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const cur = value$.getValue()
		const formatted = format(cur)
		// only touch the DOM when it actually diverges (an in-flight edit, or a value changed elsewhere). Re-pushing the
		// current value supersedes any pending debounced edit so a reset can't be resurrected by a late-firing keystroke.
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(numeric ? (formatted === '' ? '' : Number(formatted)) : formatted)
		}
	})
	return (
		<Input
			ref={ref}
			type={secret ? 'password' : numeric ? 'number' : 'text'}
			// paths, hosts and urls are the common values, and would otherwise lose their leading slash to the far end
			dir={secret || numeric ? undefined : 'auto'}
			placeholder={placeholder}
			autoFocus={autoFocus}
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(numeric ? (e.currentTarget.value === '' ? '' : e.currentTarget.valueAsNumber) : e.currentTarget.value)}
		/>
	)
}

export function SelectField({
	value$,
	reset$,
	onChange,
	options,
	node,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	// a numeric enum's options are numbers, which the select holds as strings and hands back as the option itself
	options: (string | number)[]
	node: SchemaNode
}) {
	const value = useFieldValue(value$)
	return (
		<Select
			value={value == null ? '' : String(value)}
			onValueChange={(picked) => onChange(options.find((opt) => String(opt) === picked) ?? picked)}
		>
			<SelectTrigger className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((opt) => (
					<SelectItem key={String(opt)} value={String(opt)}>
						{tr.text(SETTINGS_Msgs.settingOption(node, String(opt)))}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

export function SwitchField({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void }) {
	const value = useFieldValue(value$)
	return <Switch checked={!!value} onCheckedChange={onChange} />
}

export function EnumArrayField({
	value$,
	reset$,
	onChange,
	options,
	node,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	options: string[]
	node: SchemaNode
}) {
	const value = useFieldValue(value$) as any[]
	return (
		<ComboBoxMulti
			title={tr.text(SETTINGS_Msgs.enumValuePicker())}
			values={value ?? []}
			options={options.map((opt) => ({ value: opt, label: tr.text(SETTINGS_Msgs.settingOption(node, opt)) }))}
			onSelect={(next) => onChange(typeof next === 'function' ? next(value ?? []) : next)}
		/>
	)
}

// nullable scalar: an "unset" checkbox toggles between null and the field's empty value; the inner control reads value$
export function NullableField({
	inner,
	value$,
	reset$,
	onChange,
	children,
}: {
	inner: SchemaNode
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	children: React.ReactNode
}) {
	const value = useFieldValue(value$)
	const isNull = value === null || value === undefined
	return (
		<div className="flex items-center gap-2">
			<label className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
				<Checkbox
					checked={isNull}
					onCheckedChange={(c) => {
						onChange(c ? null : emptyValue(inner))
						reset$.next()
					}}
				/>
				{tr.text(SETTINGS_Msgs.unsetField())}
			</label>
			{!isNull && <div className="flex-1 min-w-0">{children}</div>}
		</div>
	)
}

// a ghost icon button with a tooltip that still shows when the button is disabled: the wrapping span keeps receiving
// hover events even though the disabled button sets `pointer-events-none`.
export function TooltipButton({
	disabled,
	tooltip,
	onClick,
	children,
}: {
	disabled: boolean
	tooltip: string
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<span className="inline-flex">
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-6 w-6 shrink-0 text-muted-foreground"
						disabled={disabled}
						onClick={onClick}
					>
						{children}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	)
}

export function JsonFallback({
	value$,
	reset$,
	onChange,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: unknown) => void
}) {
	const [text, setText] = React.useState(() => JSON.stringify(value$.getValue(), null, 2))
	const [error, setError] = React.useState('')
	useReset(reset$, () => {
		setText(JSON.stringify(value$.getValue(), null, 2))
		setError('')
	})
	return (
		<div className="space-y-1">
			<textarea
				className="w-full font-mono text-xs border rounded-md p-2 min-h-[6rem] bg-background ltr-isolate"
				value={text}
				onChange={(e) => {
					setText(e.target.value)
					try {
						onChange(JSON.parse(e.target.value))
						setError('')
					} catch {
						setError(tr.text(SETTINGS_Msgs.invalidJson()))
					}
				}}
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	)
}
