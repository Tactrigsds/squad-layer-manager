import * as AR from '@/app-routes.ts'
import { useDebounced } from '@/hooks/use-debounce'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import * as Arr from '@/lib/array.ts'
import { sleepUntil } from '@/lib/async'
import * as Obj from '@/lib/object.ts'
import { eltToFocusable, Focusable } from '@/lib/react'
import { cn } from '@/lib/utils.ts'
import * as EFB from '@/models/editable-filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { useLayerComponents as useLayerComponent, useSearchIds } from '@/systems.client/layer-queries.client.ts'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { Braces, EqualNot, ExternalLink, Minus, Plus, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import React from 'react'
import { Link } from 'react-router-dom'
import ComboBoxMulti, { ComboBoxMultiProps } from './combo-box/combo-box-multi.tsx'
import ComboBox, { ComboBoxHandle, ComboBoxOption } from './combo-box/combo-box.tsx'
import { LOADING } from './combo-box/constants.ts'
import FilterTextEditor, { FilterTextEditorHandle } from './filter-text-editor.tsx'
import { Button, buttonVariants } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Label } from './ui/label.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'
import { Toggle } from './ui/toggle.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

const depthColors = ['border-red-500', 'border-green-500', 'border-blue-500', 'border-yellow-500']

function getNodeWrapperClasses(depth: number, invalid: boolean) {
	const base = 'p-2 border-l-2 w-full'
	const depthColor = depth === 0 ? 'border-secondary' : depthColors[depth % depthColors.length]
	const validColor = invalid ? 'bg-red-400/10' : ''
	return cn(base, depthColor, validColor)
}

export type FilterCardProps = {
	defaultEditing?: boolean
	node: F.EditableFilterNode
	// weird way of passing this down but I guess good for perf?
	setNode: React.Dispatch<React.SetStateAction<F.EditableFilterNode | undefined>>
	resetFilter?: () => void
	filterId?: string
}

const triggerClass =
	'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow'
export default function FilterCard(props: FilterCardProps & { children: React.ReactNode }) {
	const [activeTab, setActiveTab] = React.useState('builder' as 'builder' | 'text')
	const editorRef = React.useRef<FilterTextEditorHandle>(null)
	const validFilterNode = React.useMemo(() => F.isValidFilterNode(props.node), [props.node])
	return (
		<div defaultValue="builder" className="w-full space-x-2 flex">
			<div className="flex-1">
				<div className={activeTab === 'builder' ? '' : 'hidden'}>
					<FilterNodeDisplay depth={0} {...props} />
				</div>
				<div className={activeTab === 'text' ? '' : 'hidden'}>
					<FilterTextEditor ref={editorRef} node={props.node} setNode={(node) => props.setNode(() => node as F.EditableFilterNode)} />
				</div>
			</div>
			{/* -------- toolbar -------- */}
			<div className="flex flex-col space-y-2">
				<div className="flex items-center space-x-1 justify-end">
					{/* -------- format -------- */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={() => editorRef.current?.format()}
								variant="ghost"
								size="icon"
								className={activeTab === 'text' ? '' : 'invisible'}
							>
								<Braces color="hsl(var(--muted-foreground))" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reformat</p>
						</TooltipContent>
					</Tooltip>

					{/* -------- reset filter -------- */}
					{props.resetFilter && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button onClick={() => props.resetFilter?.()} variant="ghost" size="icon">
									<Undo2 color="hsl(var(--muted-foreground))" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Reset Filter</p>
							</TooltipContent>
						</Tooltip>
					)}
				</div>
				<div className="flex items-center space-x-1 justify-end">
					{props.children}
				</div>
				<div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
					<button
						type="button"
						disabled={!validFilterNode && F.isEditableBlockNode(props.node) && props.node.children.length > 0}
						data-state={activeTab === 'text' && 'active'}
						onClick={() => {
							setActiveTab('text')
							editorRef.current!.focus()
						}}
						className={triggerClass}
					>
						Text
					</button>
					<button
						type="button"
						data-state={activeTab === 'builder' && 'active'}
						onClick={() => setActiveTab('builder')}
						className={triggerClass}
					>
						Builder
					</button>
				</div>
			</div>
		</div>
	)
}
function NegationToggle({ pressed, onPressedChange }: { pressed: boolean; onPressedChange: (pressed: boolean) => void }) {
	return (
		<Toggle
			aria-label="negate"
			pressed={pressed}
			onPressedChange={onPressedChange}
			variant="default"
			className="h-9 px-2 hover:bg-destructive/90 data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground"
		>
			<EqualNot className="w-4" />
		</Toggle>
	)
}

export function FilterNodeDisplay(props: FilterCardProps & { depth: number }) {
	const { node, setNode } = props
	const isValid = F.isLocallyValidFilterNode(node)
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
	const [editedChildIndex, setEditedChildIndex] = useState<number | undefined>()

	const negationToggle = (
		<NegationToggle
			pressed={node.neg}
			onPressedChange={(neg) =>
				setNode(
					Im.produce((draft) => {
						if (draft) {
							draft.neg = neg
						}
					}),
				)}
		/>
	)

	const deleteNode = () => {
		setNode(undefined)
	}

	if (node.type === 'and' || node.type === 'or') {
		const childrenLen = node.children.length
		const children = node.children?.map((child, i) => {
			const setChild: React.Dispatch<React.SetStateAction<F.EditableFilterNode | undefined>> = (update) => {
				setNode(
					Im.produce((draft) => {
						if (!draft || (draft.type !== 'and' && draft.type !== 'or') || draft.children.length !== childrenLen) {
							return
						}
						const newValue = typeof update === 'function' ? update(draft.children[i]) : update
						if (newValue) draft.children[i] = newValue
						else draft.children.splice(i, 1)
					}),
				)
			}

			return (
				<FilterNodeDisplay
					defaultEditing={editedChildIndex === i}
					depth={props.depth + 1}
					key={i}
					node={child}
					setNode={setChild}
					filterId={props.filterId}
				/>
			)
		})
		const addNewChild = (type: F.EditableFilterNode['type']) => {
			setNode(
				Im.produce((draft) => {
					if (!draft || !F.isEditableBlockNode(draft)) {
						setEditedChildIndex(undefined)
						return
					}
					setEditedChildIndex(draft.children.length)
					if (type === 'comp') draft.children.push(EFB.comp())
					if (type === 'apply-filter') draft.children.push(EFB.applyFilter())
					if (F.isBlockType(type)) {
						draft.children.push(EFB.createBlock(type)())
					}
				}),
			)
		}
		function changeBlockNodeType(type: F.BlockType) {
			setNode(
				Im.produce((draft) => {
					if (!draft || !F.isEditableBlockNode(draft)) return
					draft.type = type
				}),
			)
		}

		return (
			<div ref={wrapperRef} className={cn(getNodeWrapperClasses(props.depth, invalid), 'relative flex flex-col space-y-2')}>
				<div className="flex items-center space-x-1">
					{negationToggle}
					<ComboBox
						className="w-min"
						title={'Block Type'}
						value={node.type}
						options={['and', 'or']}
						onSelect={(v) => changeBlockNodeType(v as F.BlockType)}
					/>
					{props.depth > 0 && (
						<Button size="icon" variant="ghost" onClick={() => deleteNode()}>
							<Minus color="hsl(var(--destructive))" />
						</Button>
					)}
				</div>
				{children!}
				<span>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button className="min-h-0" size="icon" variant="outline">
								<Plus />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem onClick={() => addNewChild('comp')}>comparison</DropdownMenuItem>
							<DropdownMenuItem onClick={() => addNewChild('apply-filter')}>apply existing filter</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={() => addNewChild('and')}>and block</DropdownMenuItem>
							<DropdownMenuItem onClick={() => addNewChild('or')}>or block</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</span>
			</div>
		)
	}

	const setComp: React.Dispatch<React.SetStateAction<F.EditableComparison>> = (update) => {
		setNode(
			Im.produce((draft) => {
				if (!draft) return
				if (draft.type !== 'comp') return
				draft.comp = typeof update === 'function' ? update(draft.comp) : update
			}),
		)
	}

	if (node.type === 'comp' && node.comp) {
		return (
			<div ref={wrapperRef} className={cn(getNodeWrapperClasses(props.depth, invalid), 'flex items-center space-x-1')}>
				{negationToggle}
				<Comparison defaultEditing={props.defaultEditing} comp={node.comp} setComp={setComp} />
				<Button size="icon" variant="ghost" onClick={() => setNode(() => undefined)}>
					<Minus color="hsl(var(--destructive))" />
				</Button>
			</div>
		)
	}
	if (node.type === 'apply-filter') {
		return (
			<div ref={wrapperRef} className={cn(getNodeWrapperClasses(props.depth, invalid), 'flex items-center space-x-1')}>
				{negationToggle}
				<ApplyFilter
					defaultEditing={props.defaultEditing}
					filterId={node.filterId}
					editedFilterId={props.filterId}
					setFilterId={(filterId) => {
						return setNode((n) => {
							if (!n) return
							return { ...n, filterId }
						})
					}}
				/>
				<Link
					to={AR.link('/filters/:id', node.filterId ?? '')}
					target="_blank"
					className={cn(!node.filterId ? 'invisible' : '', buttonVariants({ variant: 'ghost', size: 'icon' }), 'font-light')}
				>
					<ExternalLink color="hsl(var(--primary))" />
				</Link>
				<Button size="icon" variant="ghost" onClick={() => setNode(() => undefined)}>
					<Minus color="hsl(var(--destructive))" />
				</Button>
			</div>
		)
	}

	throw new Error('Invalid node type ' + node.type)
}
const LIMIT_AUTOCOMPLETE_COLS: L.LayerColumnKey[] = ['id']

export function Comparison(props: {
	comp: F.EditableComparison
	setComp: React.Dispatch<React.SetStateAction<F.EditableComparison>>
	columnEditable?: boolean
	allowedColumns?: L.LayerColumnKey[]
	allowedComparisonCodes?: F.ComparisonCode[]
	baseQueryInput?: LQY.LayerQueryBaseInput
	showValueDropdown?: boolean
	lockOnSingleOption?: boolean
	defaultEditing?: boolean
	highlight?: boolean
	columnLabel?: string
}) {
	const showValueDropdown = props.showValueDropdown ?? true
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const { comp, setComp } = props
	let { columnEditable } = props
	columnEditable ??= true
	const columnBoxRef = useRef<Focusable>(null)
	const codeBoxRef = useRef<Focusable>(null)
	const valueBoxRef = useRef<Focusable>(null)
	const alreadyOpenedRef = useRef(false)
	const cfg = ConfigClient.useEffectiveColConfig()
	useEffect(() => {
		if (props.defaultEditing && !columnBoxRef.current!.isFocused && !alreadyOpenedRef.current) {
			columnBoxRef.current?.focus()
			alreadyOpenedRef.current = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const columnOptions = (props.allowedColumns ? props.allowedColumns : [...F.COMPOSITE_COLUMNS.options, ...LC.COLUMN_KEYS]).map((c) => ({
		value: c,
	}))

	let codeOptions: ComboBoxOption<string>[] = []
	if (comp.column && cfg) {
		const res = F.getComparisonTypesForColumn(comp.column, cfg)
		if (res.code !== 'ok') {
			return <div>{comp.column} {comp.code} : {res.code} : {res.message}</div>
		}
		codeOptions = res.comparisonTypes.map((c) => ({ value: c.code, label: c.displayName }))
	}

	if (props.allowedComparisonCodes) {
		codeOptions = codeOptions.filter((c) => Arr.includes(props.allowedComparisonCodes!, c.value))
	}

	const componentStyles = props.highlight ? 'bg-accent' : undefined

	const columnBox = columnEditable
		? (
			<ComboBox
				title={props.columnLabel ?? 'Column'}
				className={componentStyles}
				allowEmpty={true}
				value={comp.column}
				options={columnOptions}
				ref={columnBoxRef}
				onSelect={(column) => {
					if (!column) return setComp(() => ({ column: undefined }))
					const colType = F.getColumnTypeWithComposite(column, cfg)
					if (!colType) {
						throw new Error('Unknown column ' + column)
					}
					const defaultComparisonType = F.getDefaultComparison(colType)
					setComp((c) => {
						return { column, code: c.code ?? defaultComparisonType }
					})
					sleepUntil(() => valueBoxRef.current).then((handle) => {
						return handle?.focus()
					})
				}}
			/>
		)
		: (
			<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none', componentStyles)}>
				{props.columnLabel ?? comp.column}
			</span>
		)
	if (!comp.column) return columnBox

	const codeBox = (
		<ComboBox
			allowEmpty={true}
			className={componentStyles}
			title=""
			value={comp.code}
			options={codeOptions}
			ref={codeBoxRef}
			onSelect={(_code) => {
				const code = _code as typeof comp.code
				// instead of doing this cringe sleepUntil thing we could buffer events to send to newly created Config components and send them on mount, but I thought of that after coming up with this solution ¯\_(ツ)_/¯. flushSync is also an option but I don't think blocking this event on a react rerender is a good idea
				if (code !== undefined) {
					sleepUntil(() => valueBoxRef.current).then((handle) => handle?.focus())
				}
				return setComp((c) => ({ ...c, code: code ?? undefined }))
			}}
		/>
	)

	if (!showValueDropdown) {
		return (
			<>
				{columnBox}
				{codeBox}
			</>
		)
	}

	let valueBox: React.ReactNode = undefined
	switch (comp.code) {
		case 'neq':
		case 'eq': {
			if (!Arr.includes(LIMIT_AUTOCOMPLETE_COLS, comp.column)) {
				valueBox = (
					<StringEqConfig
						ref={valueBoxRef}
						className={componentStyles}
						lockOnSingleOption={lockOnSingleOption}
						column={comp.column as LC.GroupByColumn}
						value={comp.value as string | undefined | null}
						setValue={(value) => {
							return setComp((c) => ({ ...c, value }))
						}}
						baseQueryInput={props.baseQueryInput}
					/>
				)
			} else {
				valueBox = (
					<StringEqConfigLimitedAutocomplete
						ref={valueBoxRef}
						className={componentStyles}
						column={comp.column}
						value={comp.value as string | undefined | null}
						setValue={(value) => setComp((c) => ({ ...c, value }))}
						baseQueryInput={props.baseQueryInput}
					/>
				)
			}
			break
		}

		case 'in': {
			if (!Arr.includes(LIMIT_AUTOCOMPLETE_COLS, comp.column)) {
				valueBox = (
					<StringInConfig
						className={componentStyles}
						ref={valueBoxRef}
						column={comp.column as LC.GroupByColumn}
						values={(comp.values ?? []) as string[]}
						baseQueryInput={props.baseQueryInput}
						setValues={(action) => {
							setComp(
								Im.produce((c) => {
									const values = typeof action === 'function' ? action(c.values ?? []) : action
									c.values = values.length === 0 ? undefined : values
								}),
							)
						}}
					/>
				)
			} else {
				valueBox = (
					<StringInConfigLimitAutoComplete
						ref={valueBoxRef}
						column={comp.column}
						values={comp.values ?? []}
						setValues={(values) => {
							// @ts-expect-error idc
							return setComp((c) => ({ ...c, values }))
						}}
						baseQueryInput={props.baseQueryInput}
						className={componentStyles}
					/>
				)
			}
			break
		}

		case 'factions:allow-matchups': {
			valueBox = (
				<FactionsAllowMatchupsConfig
					className={componentStyles}
					ref={valueBoxRef}
					baseQueryInput={props.baseQueryInput}
					masks={comp.allMasks}
					setMode={(mode) => {
						return setComp((c) => ({ ...c, mode }))
					}}
					mode={comp.mode}
					setMasks={(action) => {
						setComp(
							Im.produce((c) => {
								c.allMasks = typeof action === 'function' ? action(c.allMasks) : action
							}),
						)
					}}
				/>
			)
			break
		}

		case 'gt':
		case 'lt': {
			valueBox = (
				<div className="w-[100px]">
					<NumericSingleValueConfig
						ref={valueBoxRef}
						className={componentStyles}
						value={comp.value as number | undefined}
						setValue={(value) => {
							return setComp((c) => ({ ...c, value }))
						}}
					/>
				</div>
			)
			break
		}

		case 'inrange': {
			valueBox = (
				<NumericRangeConfig
					className={componentStyles}
					ref={valueBoxRef}
					range={comp.range ?? [undefined, undefined]}
					setValues={(update) => {
						if (typeof update === 'function') {
							update = update(comp.range ?? [undefined, undefined])
						}
						setComp((c) => ({ ...c, range: update }))
					}}
				/>
			)
			break
		}

		case 'is-true': {
			valueBox = <span />
			break
		}

		default:
			comp.code satisfies undefined
			valueBox = <span />
	}
	return (
		<>
			{columnBox}
			{codeBox}
			{valueBox}
		</>
	)
}

type ApplyFilterProps = {
	filterId: string | undefined
	setFilterId: (filterId: string) => void
	// the id of the filter entity currently being edited
	editedFilterId?: string
	defaultEditing?: boolean
}

function ApplyFilter(props: ApplyFilterProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const options: ComboBoxOption<string>[] = []
	for (const filter of filters.values()) {
		if (props.editedFilterId && filter.id === props.editedFilterId) continue

		options.push({ label: filter.name, value: filter.id })
	}
	const boxRef = useRef<ComboBoxHandle>()
	React.useEffect(() => {
		if (props.defaultEditing) {
			boxRef.current?.focus()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	return (
		<>
			<span>Apply</span>
			<ComboBox
				title="Filter"
				options={options}
				allowEmpty={true}
				value={props.filterId}
				onSelect={(v) => {
					return props.setFilterId(v as string)
				}}
			/>
		</>
	)
}

const StringEqConfig = React.forwardRef(function StringEqConfig<T extends string | null>(
	props: {
		value: T | undefined
		column: LC.GroupByColumn
		setValue: (value: T | undefined) => void
		baseQueryInput?: LQY.LayerQueryBaseInput
		className?: string
		lockOnSingleOption?: boolean
	},
	ref: React.ForwardedRef<ComboBoxHandle>,
) {
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const valuesRes = useLayerComponent({ ...(props.baseQueryInput ?? {}), column: props.column })
	const options = (valuesRes.isSuccess && valuesRes.data) ? valuesRes.data : LOADING
	return (
		<ComboBox
			ref={ref}
			allowEmpty={true}
			className={props.className}
			title={props.column}
			disabled={valuesRes.isSuccess && lockOnSingleOption && options.length === 1}
			value={(valuesRes.isSuccess && lockOnSingleOption && options.length === 1) ? options[0] : props.value}
			options={options}
			onSelect={(v) => props.setValue(v as T | undefined)}
		/>
	)
})

const StringEqConfigLimitedAutocomplete = React.forwardRef(function StringEqConfigLimitedAutocomplete<T extends string | null>(
	props: {
		value: T | undefined
		column: string
		setValue: (value: T | undefined) => void
		baseQueryInput?: LQY.LayerQueryBaseInput
		className?: string
	},
	ref: React.ForwardedRef<ComboBoxHandle>,
) {
	const autocomplete = useDynamicColumnAutocomplete(props.column, props.value, props.baseQueryInput)
	return (
		<ComboBox
			ref={ref}
			allowEmpty={false}
			title={props.column}
			value={props.value}
			inputValue={autocomplete.inputValue}
			setInputValue={autocomplete.setInputValue}
			options={autocomplete.options}
			onSelect={(v) => props.setValue(v as T | undefined)}
			className={props.className}
		/>
	)
})

function useDynamicColumnAutocomplete<T extends string | null>(
	column: string,
	value: T | undefined,
	queryContext?: LQY.LayerQueryBaseInput,
) {
	const [debouncedInput, _setDebouncedInput] = useState('')
	const [inputValue, _setInputValue] = useState<string>(value?.split?.(',')?.[0] ?? '')
	function setDebouncedInput(value: string) {
		const v = value.trim()
		_setDebouncedInput(v)
	}
	const debouncer = useDebounced({
		defaultValue: () => inputValue,
		onChange: setDebouncedInput,
		delay: 500,
	})
	function setInputValue(value: string) {
		_setInputValue(value)
		debouncer.setValue(value)
	}

	const valuesRes = useLayerComponent(
		{ ...(queryContext ?? {}), column: column as LC.GroupByColumn },
		{
			enabled: debouncedInput !== '' && column !== 'id',
		},
	)
	const idsRes = useSearchIds({ constraints: queryContext?.constraints, queryString: debouncedInput }, {
		enabled: debouncedInput !== '' && column === 'id',
	})

	let options: T[] | typeof LOADING = LOADING
	if (debouncedInput === '') options = []
	else if (debouncedInput && valuesRes.isSuccess && column !== 'id') {
		options = valuesRes.data as T[]
	} else if (debouncedInput && idsRes.isSuccess) {
		options = idsRes.data!.ids as unknown as T[]
	}

	return {
		inputValue,
		setInputValue,
		options,
	}
}

const StringInConfig = React.forwardRef(function StringInConfig(
	props: {
		values: (string | null)[]
		column: LC.GroupByColumn
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		baseQueryInput?: LQY.LayerQueryBaseInput
		className?: string
	},
	ref: React.ForwardedRef<ComboBoxHandle>,
) {
	const valuesRes = useLayerComponent({ ...(props.baseQueryInput ?? {}), column: props.column })
	return (
		<ComboBoxMulti
			title={props.column}
			ref={ref}
			values={props.values}
			options={valuesRes.data ? valuesRes.data : []}
			onSelect={props.setValues}
			className={props.className}
		/>
	)
})

const StringInConfigLimitAutoComplete = React.forwardRef(function StringInConfigLimitAutoComplete(
	props: {
		values: (string | null)[]
		column: string
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		baseQueryInput?: LQY.LayerQueryBaseInput
		className?: string
	},
	ref: React.ForwardedRef<ComboBoxHandle>,
) {
	const autocomplete = useDynamicColumnAutocomplete(props.column, props.values[0] ?? '', props.baseQueryInput)
	return (
		<ComboBoxMulti
			title={props.column}
			ref={ref}
			values={props.values}
			options={autocomplete.options}
			onSelect={props.setValues as ComboBoxMultiProps['onSelect']}
			inputValue={autocomplete.inputValue}
			setInputValue={autocomplete.setInputValue}
			className={props.className}
		/>
	)
})

const NumericSingleValueConfig = React.forwardRef(
	(
		props: {
			placeholder?: string
			className?: string
			value?: number
			setValue: (value?: number) => void
		},
		forwardedRef: React.ForwardedRef<Focusable>,
	) => {
		const [value, setValue] = useState(props.value?.toString() ?? '')
		const inputRef = React.useRef<HTMLInputElement>(null)
		React.useImperativeHandle(forwardedRef, () => eltToFocusable(inputRef.current!))
		return (
			<Input
				ref={inputRef}
				className={props.className}
				placeholder={props.placeholder}
				value={value}
				onChange={(e) => {
					setValue(e.target.value)
					const value = e.target.value.trim()
					// TODO debounce
					return props.setValue(value === '' ? undefined : parseFloat(value))
				}}
			/>
		)
	},
)

const NumericRangeConfig = React.forwardRef(function NumericRangeConfig(
	props: {
		range: [number | undefined, number | undefined]
		setValues: React.Dispatch<React.SetStateAction<[number | undefined, number | undefined]>>
		className?: string
	},
	ref: React.ForwardedRef<Focusable>,
) {
	function setFirst(value: number | undefined) {
		props.setValues((values) => [value, values[1]])
	}
	function setSecond(value: number | undefined) {
		props.setValues((values) => [values[0], value])
	}

	return (
		<div className={cn(props.className, 'flex w-[200px] items-center space-x-2')}>
			<NumericSingleValueConfig value={props.range[0]} setValue={setFirst} />
			<span>to</span>
			<NumericSingleValueConfig ref={ref} value={props.range[1]} setValue={setSecond} />
		</div>
	)
})

const FactionsAllowMatchupsConfig = React.forwardRef(function FactionsAllowMatchupsConfig(props: {
	masks?: F.FactionMask[][]
	setMasks: React.Dispatch<React.SetStateAction<F.FactionMask[][] | undefined>>
	mode?: 'split' | 'both' | 'either'
	setMode?: (mode: 'split' | 'both' | 'either') => void
	baseQueryInput?: LQY.LayerQueryBaseInput
	className?: string
}, ref: React.ForwardedRef<Focusable>) {
	const masks = props.masks ?? []
	const [isEditOpen, setIsEditOpen] = useState(false)

	// Helper function to check if a mask is empty
	function isMaskEmpty(mask: F.FactionMask): boolean {
		return !mask.alliance && !mask.faction && !mask.unit
	}

	// Helper function to clean up empty masks
	function cleanupEmptyMasks() {
		const cleanedMasks = masks.map(team => team.filter(mask => !isMaskEmpty(mask)))
		// Only update if there are changes
		const hasChanges = cleanedMasks.some((team, index) =>
			team.length !== masks[index]?.length
			|| team.some((mask, maskIndex) => mask !== masks[index]?.[maskIndex])
		)
		if (hasChanges) {
			props.setMasks(cleanedMasks.filter(team => team.length > 0))
		}
	}

	// Handle popover close with cleanup
	function handlePopoverOpenChange(open: boolean) {
		if (!open) {
			cleanupEmptyMasks()
		}
		setIsEditOpen(open)
	}

	// Helper function to format mask for display
	function formatMask(mask: F.FactionMask): string {
		const parts = []
		if (mask.alliance && mask.alliance.length > 0) parts.push(mask.alliance.join(', '))
		if (mask.faction && mask.faction.length > 0) parts.push(mask.faction.join(', '))
		if (mask.unit && mask.unit.length > 0) parts.push(mask.unit.join(', '))
		return parts.join(' / ')
	}

	// Helper function to format team for display
	function formatTeam(team: F.FactionMask[]): string {
		if (team.length === 0) return 'No masks'
		return team.map(formatMask).join(', ')
	}

	// Display component
	const DisplayMode = () => (
		<div className={cn(props.className, 'flex items-center space-x-2')}>
			<div className="flex-1 min-w-0">
				<div className="space-y-1">
					<div className="text-sm">
						<span className="font-medium">Mode:</span> {props.mode ?? 'either'}
					</div>
					{masks.length === 0
						? <span className="text-sm text-muted-foreground italic">No faction masks configured</span>
						: masks.length === 1
						? <span className="text-sm">{formatTeam(masks[0])}</span>
						: (
							<div className="space-y-1">
								<div className="text-sm">
									<span className="font-medium">Team 1:</span> {formatTeam(masks[0])}
								</div>
								<div className="text-sm">
									<span className="font-medium">Team 2:</span> {formatTeam(masks[1])}
								</div>
							</div>
						)}
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				onClick={() => setIsEditOpen(true)}
				className="shrink-0"
			>
				<Icons.Edit />
			</Button>
		</div>
	)

	// Edit component
	const EditMode = () => {
		const currentMode = props.mode ?? 'either'
		const isSplitMode = currentMode === 'split'

		// Helper function to get team masks
		function getTeam1Masks(): F.FactionMask[] | undefined {
			return masks[0]
		}

		function getTeam2Masks(): F.FactionMask[] | undefined {
			return masks[1]
		}

		// Helper function to update team masks
		function updateTeam(teamIndex: 1 | 2, newMasks: React.SetStateAction<F.FactionMask[] | undefined>) {
			props.setMasks(currentMasks => {
				const resolvedNewMasks = typeof newMasks === 'function' ? newMasks(currentMasks?.[teamIndex - 1]) : newMasks

				if (isSplitMode) {
					const newTeams = [...(currentMasks ?? [])]

					if (teamIndex === 1) {
						if (resolvedNewMasks) {
							newTeams[0] = resolvedNewMasks
						} else {
							newTeams.splice(0, 1)
						}
						return newTeams.length > 0 ? newTeams : []
					} else {
						// Ensure team 1 exists
						if (newTeams.length === 0) newTeams.push([])

						if (resolvedNewMasks) {
							newTeams[1] = resolvedNewMasks
						} else if (newTeams.length > 1) {
							newTeams.splice(1, 1)
						}
						return newTeams
					}
				} else if (teamIndex === 1) {
					// Single team mode - just set the masks directly
					return resolvedNewMasks ? [resolvedNewMasks] : []
				}

				return currentMasks
			})
		}

		// Handle mode change
		function handleModeChange(newMode: 'split' | 'both' | 'either') {
			if (props.setMode) {
				props.setMode(newMode)
			}

			if (newMode === 'split') {
				// Split into two teams
				props.setMasks(currentMasks => {
					const team1 = currentMasks?.[0] ?? []
					return [team1, []]
				})
			} else {
				// Merge into one team
				props.setMasks(currentMasks => {
					return [(currentMasks ?? []).flat()]
				})
			}
		}

		const modeSelectId = React.useId()

		return (
			<div className="flex flex-col space-y-4 w-max">
				<div className="flex items-center justify-between">
					<div className="flex items-center space-x-2">
						<Label htmlFor={modeSelectId} className="text-sm font-medium">
							Mode:
						</Label>
						<ComboBox
							ref={ref}
							allowEmpty={false}
							className="w-32"
							title="Mode"
							value={currentMode}
							options={[
								{ value: 'split', label: 'Split' },
								{ value: 'both', label: 'Both' },
								{ value: 'either', label: 'Either' },
							]}
							onSelect={(v) => handleModeChange(v as 'split' | 'both' | 'either')}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setIsEditOpen(false)}
						>
							Done
						</Button>
					</div>
				</div>

				{isSplitMode
					? (
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							<div className="space-y-2">
								<h4 className="text-sm font-medium">Team 1</h4>
								<FactionMaskListConfig
									ref={ref}
									value={getTeam1Masks()}
									setValue={update => updateTeam(1, update)}
									queryContext={props.baseQueryInput}
									className="w-full"
									onSwitchMaskTeam={(mask, index) => {
										props.setMasks(currentMasks => {
											// Remove from team 1
											const newTeam1 = [...(currentMasks?.[0] ?? [])]
											newTeam1.splice(index, 1)
											// Add to team 2
											const newTeam2 = [...(currentMasks?.[1] ?? []), mask]
											return [newTeam1, newTeam2]
										})
									}}
									showTeamSwitch={isSplitMode}
									currentTeam={1}
								/>
							</div>
							<div className="space-y-2">
								<h4 className="text-sm font-medium">Team 2</h4>
								<FactionMaskListConfig
									value={getTeam2Masks()}
									setValue={update => updateTeam(2, update)}
									queryContext={props.baseQueryInput}
									className="w-full"
									onSwitchMaskTeam={(mask, index) => {
										props.setMasks(currentMasks => {
											// Remove from team 2
											const newTeam2 = [...(currentMasks?.[1] ?? [])]
											newTeam2.splice(index, 1)
											// Add to team 1
											const newTeam1 = [...(currentMasks?.[0] ?? []), mask]
											return [newTeam1, newTeam2]
										})
									}}
									showTeamSwitch={isSplitMode}
									currentTeam={2}
								/>
							</div>
						</div>
					)
					: (
						<div className="space-y-2">
							<FactionMaskListConfig
								ref={ref}
								value={getTeam1Masks()}
								setValue={update => updateTeam(1, update)}
								queryContext={props.baseQueryInput}
								className="w-full"
							/>
						</div>
					)}
			</div>
		)
	}

	return (
		<Popover open={isEditOpen} onOpenChange={handlePopoverOpenChange}>
			<PopoverTrigger asChild>
				<div>
					<DisplayMode />
				</div>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-4" side="bottom" align="start">
				<EditMode />
			</PopoverContent>
		</Popover>
	)
})

const FactionMaskConfig = React.forwardRef(function FactionMaskConfig(props: {
	value: F.FactionMask | undefined
	setValue: React.Dispatch<React.SetStateAction<F.FactionMask | undefined>>
	queryContext?: LQY.LayerQueryBaseInput
	className?: string
}, ref: React.ForwardedRef<Focusable>) {
	const responses = {
		alliance1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Alliance_1' }),
		alliance2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Alliance_2' }),
		faction1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Faction_1' }),
		faction2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Faction_2' }),
		unit1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Unit_1' }),
		unit2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Unit_2' }),
	}

	const mask = props.value ?? {}

	const allPopulated = Object.values(responses).every(res => !!res.data)

	// Get available options from the query context
	const { alliances, factions, units } = React.useMemo(() => {
		if (!allPopulated) return { alliances: [], factions: [], units: [] }
		return {
			alliances: Arr.union(responses.alliance1Res.data!, responses.alliance2Res.data!),
			factions: Arr.union(responses.faction1Res.data!, responses.faction2Res.data!),
			units: Arr.union(responses.unit1Res.data!, responses.unit2Res.data!),
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...Object.values(responses), allPopulated])

	// Helper function to update the mask
	function updateMask(field: keyof F.FactionMask, update: React.SetStateAction<(string | null)[]>) {
		props.setValue((prev) => {
			const currentValue = prev?.[field] ?? undefined
			let value = typeof update === 'function' ? update(currentValue ?? []) : update
			value = value.filter((v) => v !== null)

			const newPrev = prev ?? {}

			if (value && value.length > 0) {
				return { ...newPrev, [field]: value }
			} else {
				const { [field]: _, ...rest } = newPrev
				return rest
			}
		})
	}

	return (
		<div className={cn(props.className, 'flex flex-col space-y-2 w-[300px]')}>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Alliance:</span>
				<ComboBoxMulti
					className="flex-1"
					title="Alliance"
					values={mask.alliance ?? []}
					options={allPopulated ? alliances : LOADING}
					onSelect={(v) => updateMask('alliance', v)}
				/>
			</div>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Faction:</span>
				<ComboBoxMulti
					className="flex-1"
					title="Faction"
					values={mask.faction ?? []}
					options={allPopulated ? factions : LOADING}
					onSelect={(v) => updateMask('faction', v)}
				/>
			</div>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Unit:</span>
				<ComboBoxMulti
					ref={ref}
					className="flex-1"
					title="Unit"
					values={mask.unit ?? []}
					options={allPopulated ? units : LOADING}
					onSelect={(v) => updateMask('unit', v)}
				/>
			</div>
		</div>
	)
})

const FactionMaskListConfig = React.forwardRef(function FactionMaskListConfig(props: {
	value: F.FactionMask[] | undefined
	setValue: React.Dispatch<React.SetStateAction<F.FactionMask[] | undefined>>
	queryContext?: LQY.LayerQueryBaseInput
	className?: string
	onSwitchMaskTeam?: (mask: F.FactionMask, index: number) => void
	showTeamSwitch?: boolean
	currentTeam?: 1 | 2
}, ref: React.ForwardedRef<Focusable>) {
	const maskIds = React.useMemo(() => {
		return props.value?.map(mask => JSON.stringify(mask))
	}, [props.value])
	const masks = props.value ?? []
	function checkNoDuplicates(newMask: F.FactionMask, masks: F.FactionMask[]) {
		newMask = Obj.map(newMask, (value) => value ?? undefined)
		for (let mask of masks) {
			mask = Obj.map(mask, (value) => value ?? undefined)
			if (deepEqual(mask, newMask)) {
				globalToast$.next({
					variant: 'destructive',
					title: 'Duplicate Faction Mask',
					description: 'A faction mask with the same content already exists.',
				})
				return false
			}
		}
		return true
	}

	function updateMask(index: number, mask: React.SetStateAction<F.FactionMask | undefined>) {
		props.setValue(currentMasks => {
			const newMasks = [...(currentMasks ?? [])]
			const resolvedMask = typeof mask === 'function' ? mask((currentMasks ?? [])[index]) : mask
			if (resolvedMask) {
				if (!checkNoDuplicates(resolvedMask, currentMasks ?? [])) return currentMasks
				newMasks[index] = resolvedMask
			} else {
				newMasks.splice(index, 1)
			}

			if (newMasks.length === 0) {
				return undefined
			} else {
				return newMasks
			}
		})
	}

	// Helper function to add a new mask
	function addMask() {
		if (!checkNoDuplicates({}, masks)) return
		props.setValue([...masks, {}])
	}

	// Helper function to remove a mask
	function removeMask(index: number) {
		const newMasks = masks.filter((_, i) => i !== index)
		if (newMasks.length === 0) {
			props.setValue(undefined)
		} else {
			props.setValue(newMasks)
		}
	}

	return (
		<div className={cn(props.className, 'flex flex-col space-y-3 w-[350px]')}>
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">Faction Masks</span>
				<Button
					variant="outline"
					size="sm"
					onClick={addMask}
					className="h-8 w-8 p-0"
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>

			{masks.length === 0
				? (
					<div className="text-sm text-muted-foreground italic">
						No faction masks configured. Click + to add one.
					</div>
				)
				: (
					<div className="space-y-2">
						{masks.map((mask, index) => (
							<div className="flex items-start space-x-2 p-2 border rounded-md" key={maskIds![index]}>
								<div className="flex-1">
									<FactionMaskConfig
										ref={index === 0 ? ref : undefined}
										value={mask}
										setValue={(newMask) => updateMask(index, newMask)}
										queryContext={props.queryContext}
										className="w-full"
									/>
								</div>
								<div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => removeMask(index)}
										className="h-8 w-8 p-0 text-destructive hover:text-destructive"
									>
										<Minus className="h-4 w-4" />
									</Button>
									{props.showTeamSwitch && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => props.onSwitchMaskTeam?.(mask, index)}
											className="h-6 px-2 text-xs"
											title={`Move to Team ${props.currentTeam === 1 ? 2 : 1}`}
										>
											<Icons.ArrowLeftRight className="h-3 w-3" />
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				)}
		</div>
	)
})
