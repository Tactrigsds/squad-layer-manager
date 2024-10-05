import { useDebounced } from '@/hooks/use-debounce'
import * as DH from '@/lib/displayHelpers'
import { SetState } from '@/lib/react'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import * as S from '@/stores'
import { produce } from 'immer'
import { useAtom } from 'jotai'
import { Check, ChevronsUpDown, LoaderCircle, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from './ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export function FilterCard() {
	const [filter, setFilter] = useAtom(S.editableFilterAtom)
	return <FilterNodeDisplay node={filter} setNode={setFilter as SetState<M.EditableFilterNode | undefined>} depth={0} />
}

const depthColors = ['border-red-500', 'border-green-500', 'border-blue-500', 'border-yellow-500']
function getNodeWrapperClasses(depth: number, invalid: boolean) {
	const base = 'p-2 border-l-2 w-full'
	const depthColor = depth === 0 ? 'border-secondary' : depthColors[depth % depthColors.length]
	const validColor = invalid ? 'bg-red-400/10' : ''
	return cn(base, depthColor, validColor)
}

export function FilterNodeDisplay(props: {
	node: M.EditableFilterNode
	setNode: SetState<M.EditableFilterNode | undefined>
	depth: number
}) {
	const { node, setNode } = props
	const isValid = M.isLocallyValidFilterNode(node, props.depth)
	const [showInvalid, setShowInvalid] = useState(false)
	const invalid = !isValid && showInvalid
	const wrapperRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const elt = wrapperRef.current!
		if (isValid || !elt) return
		if (wrapperRef.current !== document.activeElement || elt.contains(document.activeElement)) {
			setShowInvalid(true)
			return
		}
		function onFocusLeave() {
			if (isValid) return
			setShowInvalid(true)
		}
		elt.addEventListener('focusout', onFocusLeave)
		return () => {
			elt.removeEventListener('focusout', onFocusLeave)
		}
	}, [isValid])

	if (node.type === 'and' || node.type === 'or') {
		const childrenLen = node.children.length
		const children = node.children?.map((child, i) => {
			const setChild: SetState<M.EditableFilterNode | undefined> = (cb) => {
				setNode(
					produce((draft) => {
						if (!draft) return
						if (draft.type !== 'and' && draft.type !== 'or') return
						if (draft.children.length !== childrenLen) return
						const newValue = cb(draft.children[i])
						if (newValue) draft.children[i] = newValue
						else draft.children.splice(i, 1)
					})
				)
			}

			return <FilterNodeDisplay depth={props.depth + 1} key={i} node={child} setNode={setChild} />
		})
		const addNewChild = (type: M.EditableFilterNode['type']) => {
			setNode(
				produce((draft) => {
					if (!draft) return
					if (draft.type !== 'and' && draft.type !== 'or') return
					if (type === 'comp') draft.children.push({ type, comp: {} })
					if (type === 'and' || type === 'or') draft.children.push({ type, children: [] })
				})
			)
		}
		const deleteNode = () => {
			setNode(() => undefined)
		}

		return (
			<div ref={wrapperRef} className={cn(getNodeWrapperClasses(props.depth, invalid), 'flex flex-col space-y-2 relative')}>
				{props.depth > 0 && <span>{node.type}</span>}
				{children!}
				{props.depth === 0 && childrenLen === 0 && <span>Click below to add some filters</span>}
				<span>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button className="min-h-0" size="icon" variant="outline">
								<Plus />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem onClick={() => addNewChild('comp')}>comparison</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={() => addNewChild('and')}>and block</DropdownMenuItem>
							<DropdownMenuItem onClick={() => addNewChild('or')}>or block</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</span>
				{props.depth > 0 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="icon" variant="outline" className="absolute top-0 right-0 translate-y-[-50%] z-10 rounded-md">
								...
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="bg-destructive" onClick={() => deleteNode()}>
								delete "{node.type}"
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		)
	}

	const setComp: SetState<M.EditableComparison> = (cb) => {
		setNode(
			produce((draft) => {
				if (!draft) return
				if (draft.type !== 'comp') return
				draft.comp = cb(draft.comp)
			})
		)
	}

	if (node.type === 'comp' && node.comp) {
		return (
			<div ref={wrapperRef} className={cn(getNodeWrapperClasses(props.depth, invalid), 'flex space-x-2')}>
				<Comparison comp={node.comp} setComp={setComp} />
				<Button size="icon" variant="ghost" onClick={() => setNode(() => undefined)}>
					<Minus color="hsl(var(--destructive))" />
				</Button>
			</div>
		)
	}

	throw new Error('Invalid node type ' + node.type)
}
const LIMIT_AUTOCOMPLETE_COLS: M.LayerColumnKey = ['id']

export function Comparison(props: { comp: M.EditableComparison; setComp: SetState<M.EditableComparison>; columnEditable?: boolean }) {
	const { comp, setComp } = props
	let { columnEditable } = props
	columnEditable ??= true

	const columnBox = columnEditable ? (
		<ComboBox
			title="Column"
			allowEmpty={true}
			value={comp.column}
			options={M.COLUMN_KEYS}
			onSelect={(column) => setComp(() => ({ column: column ?? undefined }))}
		/>
	) : (
		<span className="px-3 py-2 border rounded-md">{comp.column}</span>
	)
	if (!comp.column) return columnBox
	const columnOptions = M.getComparisonTypesForColumn(comp.column).map((c) => ({ value: c.code }))
	return (
		<>
			{columnBox}
			<ComboBox
				allowEmpty={true}
				title=""
				value={comp.code}
				options={columnOptions}
				onSelect={(code) => setComp((c) => ({ column: c.column, code: code ?? undefined }))}
			/>
			{comp.code === 'eq' && !LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringEqConfig
					column={comp.column as M.StringColumn}
					value={comp.value as string | undefined}
					setValue={(value) => setComp((c) => ({ ...c, value }))}
				/>
			)}
			{comp.code === 'eq' && LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringEqConfigLimitedAutocomplete
					column={comp.column as M.StringColumn}
					value={comp.value as string | undefined}
					setValue={(value) => setComp((c) => ({ ...c, value }))}
				/>
			)}
			{comp.code === 'in' && !LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringInConfig
					column={comp.column as M.StringColumn}
					values={(comp.values ?? []) as string[]}
					setValues={(getValues) => {
						setComp((c) => {
							return { ...c, values: getValues(c.values ?? []) }
						})
					}}
				/>
			)}
			{comp.code === 'in' && LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringInConfigLimitAutoComplete
					column={comp.column as M.StringColumn}
					values={(comp.values ?? []) as string[]}
					setValues={(getValues) => {
						setComp((c) => {
							return { ...c, values: getValues(c.values ?? []) }
						})
					}}
				/>
			)}
			{(comp.code === 'gt' || comp.code === 'lt') && (
				<NumericSingleValueConfig
					className="w-[200px]"
					value={comp.value as number | undefined}
					setValue={(value) => setComp((c) => ({ ...c, value }))}
				/>
			)}
			{comp.code === 'inrange' && (
				<NumericRangeConfig
					min={comp.min}
					max={comp.max}
					setMin={(min) => setComp((c) => ({ ...c, min }))}
					setMax={(max) => setComp((c) => ({ ...c, max }))}
				/>
			)}
		</>
	)
}

function StringEqConfig<T extends string | null>(props: {
	value: T | undefined
	column: M.StringColumn
	setValue: (value: T | undefined) => void
}) {
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery({ column: props.column })
	const options = valuesRes.isLoading ? LOADING : valuesRes.data!
	return <ComboBox allowEmpty={true} title={props.column} value={props.value} options={options} onSelect={(v) => props.setValue(v)} />
}

function StringEqConfigLimitedAutocomplete<T extends string | null>(props: {
	value: T | undefined
	limitAutoComplete?: boolean
	column: M.StringColumn
	setValue: (value: T | undefined) => void
}) {
	const limitAutoComplete = props.limitAutoComplete ?? false
	const [debouncedInput, _setDebouncedInput] = useState('')
	const [inputValue, setInputValue] = useState(props.value ?? '')
	function setDebouncedInput(value: string) {
		value = value.trim()
		_setDebouncedInput(value)
		if (value && options && options !== LOADING && options.includes(value)) {
			props.setValue(value as T)
		}
	}
	useDebounced({ value: inputValue, onChange: setDebouncedInput, delay: 500 })
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(
		{
			column: props.column,
			filter: limitAutoComplete && debouncedInput ? debouncedInput.trim() : undefined,
		},
		{
			enabled: !limitAutoComplete || debouncedInput.trim() !== '',
		}
	)
	const options = valuesRes.isLoading ? LOADING : valuesRes.data!
	return (
		<ComboBox
			allowEmpty={true}
			title={props.column}
			value={props.value}
			inputValue={inputValue}
			setInputValue={setInputValue}
			options={options}
			onSelect={(v) => props.setValue(v)}
		/>
	)
}

function StringInConfig(props: { values: string[]; column: M.StringColumn; setValues: SetState<string[]> }) {
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery({ column: props.column })
	return <ComboBoxMulti values={props.values} options={valuesRes.data ?? []} onSelect={props.setValues} />
}

function StringInConfigLimitAutoComplete(props: { values: string[]; column: M.StringColumn; setValues: SetState<string[]> }) {
	const [debouncedInput, _setDebouncedInput] = useState('')
	const [inputValue, setInputValue] = useState('')
	function setDebouncedInput(value: string) {
		value = value.trim()
		_setDebouncedInput(value)
	}
	useDebounced({ value: inputValue, onChange: setDebouncedInput, delay: 500 })
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(
		{
			column: props.column,
			filter: debouncedInput ? debouncedInput.trim() : undefined,
		},
		{
			enabled: debouncedInput.trim() !== '',
		}
	)
	const options = valuesRes.isLoading ? LOADING : valuesRes.data!
	return (
		<ComboBoxMulti
			values={props.values}
			options={options}
			onSelect={props.setValues}
			inputValue={inputValue}
			setInputValue={setInputValue}
		/>
	)
}

function NumericSingleValueConfig(props: { className?: string; value?: number; setValue: (value?: number) => void }) {
	const [value, setValue] = useState(props.value?.toString() ?? '')
	return (
		<Input
			className={props.className}
			value={value}
			onChange={(e) => {
				setValue(e.target.value)
				const value = e.target.value.trim()
				// TODO debounce
				return props.setValue(value === '' ? undefined : parseFloat(value))
			}}
		/>
	)
}

function NumericRangeConfig(props: { min?: number; max?: number; setMin: (min?: number) => void; setMax: (max?: number) => void }) {
	return (
		<div className="flex w-[200px] space-x-2 items-center">
			<NumericSingleValueConfig value={props.min} setValue={props.setMin} />
			<span>to</span>
			<NumericSingleValueConfig value={props.max} setValue={props.setMax} />
		</div>
	)
}

// can't use an actual symbol because cmdk doesn't support them afaik
type ComboBoxOption<T extends string | null> = {
	value: T
	label?: string
}
const LOADING = Symbol('loading')
function ComboBox<AllowEmpty extends boolean, T extends string | null, V = AllowEmpty extends true ? T | undefined : T>(props: {
	allowEmpty: AllowEmpty
	className?: string
	title: string
	// value of input box
	inputValue?: V
	setInputValue?: (value: V) => void
	value: V
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: (value: V) => void
}) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	let options: ComboBoxOption<T>[] | typeof LOADING
	if (props.options !== LOADING && props.options.length > 0 && (typeof props.options[0] === 'string' || props.options[0] === null)) {
		options = (props.options as T[]).map((v) => ({ value: v }))
	} else {
		options = props.options as ComboBoxOption<T>[] | typeof LOADING
	}
	//@ts-expect-error typescript is dumb
	const selectedOption = (options === LOADING ? [] : options).find((o) => o.value === props.value)
	let selectedOptionDisplay: string
	if (selectedOption?.value === null) {
		selectedOptionDisplay = DH.MISSING_DISPLAY
	} else if (selectedOption) {
		selectedOptionDisplay = selectedOption.label ?? selectedOption.value
	} else {
		selectedOptionDisplay = `Select ${props.title}...`
	}
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} className={cn('w-[min] justify-between', props.className)}>
					<span>{selectedOptionDisplay}</span>
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-min p-0">
				<Command>
					<CommandInput placeholder={`Search...`} />
					<CommandList>
						<CommandEmpty>No framework found.</CommandEmpty>
						<CommandGroup>
							{options === LOADING && (
								<CommandItem>
									<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
								</CommandItem>
							)}
							{options !== LOADING && props.allowEmpty && (
								<CommandItem
									value={DH.MISSING_DISPLAY}
									onSelect={() => {
										if (!props.allowEmpty) return
										props.onSelect(undefined)
										setOpen(false)
									}}
								>
									<Check className={cn('mr-2 h-4 w-4', props.value === undefined ? 'opacity-100' : 'opacity-0')} />
									{DH.MISSING_DISPLAY}
								</CommandItem>
							)}
							{options !== LOADING &&
								options.map((option) => (
									<CommandItem
										key={option.value}
										value={option.value === null ? NULL.current : option.value}
										onSelect={() => {
											props.onSelect(option.value as V)
											setOpen(false)
										}}
									>
										<Check className={cn('mr-2 h-4 w-4', props.value === option.value ? 'opacity-100' : 'opacity-0')} />
										{option.label ?? (option.value === null ? DH.NULL_DISPLAY : option.value)}
									</CommandItem>
								))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

function ComboBoxMulti<T extends string | null>(props: { values: T[]; options: T[]; onSelect: SetState<T[]> }) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, onSelect, options } = props
	const [open, setOpen] = useState(false)
	let valuesDisplay = values.length > 0 ? values.join(',') : 'Select...'
	if (valuesDisplay.length > 25) {
		valuesDisplay = valuesDisplay.slice(0, 25) + '...'
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} className="max-w-[400px] justify-between font-mono">
					{valuesDisplay}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0">
				<Command>
					<CommandInput placeholder="Search framework..." />
					<CommandList>
						<CommandEmpty>No framework found.</CommandEmpty>
						<CommandGroup>
							{options.map((option) => (
								<CommandItem
									key={option}
									value={option === null ? NULL.current : option}
									onSelect={(selected) => {
										onSelect((values) => {
											const selectedValue = selected as T
											if (values.includes(selectedValue)) {
												return values.filter((v) => v !== option)
											} else {
												return [...values, option]
											}
										})
									}}
								>
									<Check className={cn('mr-2 h-4 w-4', values.includes(option) ? 'opacity-100' : 'opacity-0')} />
									{option === null ? DH.NULL_DISPLAY : option}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
