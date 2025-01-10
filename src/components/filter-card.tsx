import { produce } from 'immer'
import { Braces, EqualNot, ExternalLink, Minus, Plus, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import React from 'react'
import { Link } from 'react-router-dom'

import * as AR from '@/app-routes.ts'
import { useDebounced } from '@/hooks/use-debounce'
import { sleepUntil } from '@/lib/async'
import * as EFB from '@/lib/editable-filter-builders.ts'
import * as FB from '@/lib/filter-builders.ts'
import { eltToFocusable, Focusable } from '@/lib/react'
import { cn } from '@/lib/utils.ts'
import * as M from '@/models.ts'

import ComboBoxMulti, { ComboBoxMultiProps } from './combo-box/combo-box-multi.tsx'
import ComboBox, { ComboBoxHandle, ComboBoxOption } from './combo-box/combo-box.tsx'
import { LOADING } from './combo-box/constants.ts'
import FilterTextEditor, { FilterTextEditorHandle } from './filter-text-editor.tsx'
import { Button, buttonVariants } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Toggle } from './ui/toggle.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'
import { assertNever } from '@/lib/typeGuards.ts'
import { Checkbox } from './ui/checkbox.tsx'
import { useLayersGroupedBy } from '@/hooks/use-layer-queries.ts'
import { useFilters } from '@/hooks/filters.ts'

const depthColors = ['border-red-500', 'border-green-500', 'border-blue-500', 'border-yellow-500']
function getNodeWrapperClasses(depth: number, invalid: boolean) {
	const base = 'p-2 border-l-2 w-full'
	const depthColor = depth === 0 ? 'border-secondary' : depthColors[depth % depthColors.length]
	const validColor = invalid ? 'bg-red-400/10' : ''
	return cn(base, depthColor, validColor)
}

export type FilterCardProps = {
	defaultEditing?: boolean
	node: M.EditableFilterNode
	// weird way of passing this down but I guess good for perf?
	setNode: React.Dispatch<React.SetStateAction<M.EditableFilterNode | undefined>>
	resetFilter?: () => void
	filterId?: string
}

const triggerClass =
	'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow'
export default function FilterCard(props: FilterCardProps) {
	const [activeTab, setActiveTab] = React.useState('builder' as 'builder' | 'text')
	const editorRef = React.useRef<FilterTextEditorHandle>(null)
	const validFilterNode = React.useMemo(() => M.isValidFilterNode(props.node), [props.node])
	return (
		<div defaultValue="builder" className="w-full space-y-2">
			<div className="flex w-full justify-end space-x-2">
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
				<div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
					<button
						type="button"
						disabled={!validFilterNode && M.isEditableBlockNode(props.node) && props.node.children.length > 0}
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
			<div>
				<div className={activeTab === 'builder' ? '' : 'hidden'}>
					<FilterNodeDisplay depth={0} {...props} />
				</div>
				<div className={activeTab === 'text' ? '' : 'hidden'}>
					<FilterTextEditor ref={editorRef} node={props.node} setNode={(node) => props.setNode(() => node as M.EditableFilterNode)} />
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
	const isValid = M.isLocallyValidFilterNode(node)
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
					produce((draft) => {
						if (draft) {
							draft.neg = neg
						}
					})
				)
			}
		/>
	)

	const deleteNode = () => {
		setNode(undefined)
	}

	if (node.type === 'and' || node.type === 'or') {
		const childrenLen = node.children.length
		const children = node.children?.map((child, i) => {
			const setChild: React.Dispatch<React.SetStateAction<M.EditableFilterNode | undefined>> = (update) => {
				setNode(
					produce((draft) => {
						if (!draft || (draft.type !== 'and' && draft.type !== 'or') || draft.children.length !== childrenLen) {
							return
						}
						const newValue = typeof update === 'function' ? update(draft.children[i]) : update
						if (newValue) draft.children[i] = newValue
						else draft.children.splice(i, 1)
					})
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
		const addNewChild = (type: M.EditableFilterNode['type']) => {
			setNode(
				produce((draft) => {
					if (!draft || !M.isEditableBlockNode(draft)) {
						setEditedChildIndex(undefined)
						return
					}
					setEditedChildIndex(draft.children.length)
					if (type === 'comp') draft.children.push(EFB.comp())
					if (type === 'apply-filter') draft.children.push(EFB.applyFilter())
					if (M.isBlockType(type)) {
						draft.children.push(EFB.createBlock(type)())
					}
				})
			)
		}
		function changeBlockNodeType(type: M.BlockType) {
			setNode(
				produce((draft) => {
					if (!draft || !M.isEditableBlockNode(draft)) return
					draft.type = type
				})
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
						onSelect={(v) => changeBlockNodeType(v as M.BlockType)}
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

	const setComp: React.Dispatch<React.SetStateAction<M.EditableComparison>> = (update) => {
		setNode(
			produce((draft) => {
				if (!draft) return
				if (draft.type !== 'comp') return
				draft.comp = typeof update === 'function' ? update(draft.comp) : update
			})
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
					to={AR.link('/filters/:id/edit', node.filterId ?? '')}
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
const LIMIT_AUTOCOMPLETE_COLS: (M.LayerColumnKey | M.LayerCompositeKey)[] = ['id']

export function Comparison(props: {
	comp: M.EditableComparison
	setComp: React.Dispatch<React.SetStateAction<M.EditableComparison>>
	columnEditable?: boolean
	allowedColumns?: M.LayerColumnKey[]
	allowedComparisonCodes?: M.ComparisonCode[]
	valueAutocompleteFilter?: M.FilterNode
	showValueDropdown?: boolean
	defaultEditing?: boolean
}) {
	const showValueDropdown = props.showValueDropdown ?? true
	const { comp, setComp } = props
	let { columnEditable } = props
	columnEditable ??= true
	const columnBoxRef = useRef<Focusable>(null)
	const codeBoxRef = useRef<Focusable>(null)
	const valueBoxRef = useRef<Focusable>(null)
	const alreadyOpenedRef = useRef(false)
	useEffect(() => {
		if (props.defaultEditing && !columnBoxRef.current!.isFocused && !alreadyOpenedRef.current) {
			columnBoxRef.current?.focus()
			alreadyOpenedRef.current = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	const columnOptions = (props.allowedColumns ? props.allowedColumns : M.COLUMN_KEYS_WITH_COMPUTED).map((c) => ({
		value: c,
	}))
	let codeOptions = comp.column ? M.getComparisonTypesForColumn(comp.column).map((c) => ({ value: c.code })) : []
	if (props.allowedComparisonCodes) {
		codeOptions = codeOptions.filter((c) => props.allowedComparisonCodes!.includes(c.value))
	}

	const columnBox = columnEditable ? (
		<ComboBox
			title="Column"
			allowEmpty={true}
			value={comp.column}
			options={columnOptions}
			ref={columnBoxRef}
			onSelect={(_column) => {
				if (!_column) return setComp(() => ({ column: undefined }))
				const column = _column as M.LayerColumnKey
				if (M.isColType(column, 'string')) {
					setComp((c) => {
						const code = c.code ?? 'eq'
						return { column, code }
					})
					sleepUntil(() => valueBoxRef.current).then((handle) => {
						return handle?.focus()
					})
					return
				}
				if (M.isColType(column, 'float')) {
					setComp((c) => {
						return { column, code: c.code ?? 'lt' }
					})
					sleepUntil(() => codeBoxRef.current).then((handle) => handle?.focus())
					return
				}
				if (M.isColType(column, 'collection')) {
					setComp((c) => {
						return { column, code: c.code ?? 'has', values: [] }
					})
					sleepUntil(() => codeBoxRef.current).then((handle) => handle?.focus())
					return
				}
				if (M.isColType(column, 'integer')) {
					throw new Error('integer columns are not supported')
				}
				if (M.isColType(column, 'boolean')) {
					setComp(() => ({ column, code: 'is-true' }))
					sleepUntil(() => codeBoxRef.current).then((handle) => handle?.focus())
					return
				}
				assertNever(column)
			}}
		/>
	) : (
		<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none')}>{comp.column}</span>
	)
	if (!comp.column) return columnBox

	const codeBox = (
		<ComboBox
			allowEmpty={true}
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
		case 'eq': {
			if (!LIMIT_AUTOCOMPLETE_COLS.includes(comp.column)) {
				valueBox = (
					<StringEqConfig
						ref={valueBoxRef}
						column={comp.column as M.StringColumn}
						value={comp.value as string | undefined | null}
						setValue={(value) => {
							return setComp((c) => ({ ...c, value }))
						}}
						autocompleteFilter={props.valueAutocompleteFilter}
					/>
				)
			} else {
				valueBox = (
					<StringEqConfigLimitedAutocomplete
						ref={valueBoxRef}
						column={comp.column as M.StringColumn}
						value={comp.value as string | undefined | null}
						setValue={(value) => setComp((c) => ({ ...c, value }))}
						autocompleteFilter={props.valueAutocompleteFilter}
					/>
				)
			}
			break
		}

		case 'in': {
			if (!LIMIT_AUTOCOMPLETE_COLS.includes(comp.column)) {
				valueBox = (
					<StringInConfig
						ref={valueBoxRef}
						column={comp.column as M.StringColumn}
						values={(comp.values ?? []) as string[]}
						autocompleteFilter={props.valueAutocompleteFilter}
						setValues={(action) => {
							setComp(
								produce((c) => {
									const values = typeof action === 'function' ? action(c.values ?? []) : action
									c.values = values.length === 0 ? undefined : values
								})
							)
						}}
					/>
				)
			} else {
				valueBox = (
					<StringEqConfigLimitedAutocomplete
						ref={valueBoxRef}
						column={comp.column as M.StringColumn}
						value={comp.value as string | undefined | null}
						setValue={(value) => setComp((c) => ({ ...c, value }))}
						autocompleteFilter={props.valueAutocompleteFilter}
					/>
				)
			}
			break
		}

		case 'gt':
		case 'lt': {
			valueBox = (
				<NumericSingleValueConfig
					ref={valueBoxRef}
					className="w-[200px]"
					value={comp.value as number | undefined}
					setValue={(value) => {
						return setComp((c) => ({ ...c, value }))
					}}
				/>
			)
			break
		}

		case 'inrange': {
			valueBox = (
				<NumericRangeConfig
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

		case 'has': {
			valueBox = (
				<HasAllConfig
					ref={valueBoxRef}
					column={comp.column as M.CollectionColumn}
					values={comp.values as string[]}
					setValues={(updater) => {
						//@ts-expect-error idk
						const values = typeof updater === 'function' ? updater(comp.values ?? []) : updater
						return setComp((c) => ({
							...c,
							values: values as (string | null)[],
						}))
					}}
				/>
			)
			break
		}

		case 'is-true': {
			valueBox = <span />
			break
		}

		case 'like': {
			valueBox = (
				<StringLikeConfig
					setValue={(newValue) => {
						setComp(
							produce((c) => {
								c.value = newValue
							})
						)
					}}
					value={(comp.value as string)!}
				/>
			)
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
	const getFiltersQuery = useFilters()
	let filters = getFiltersQuery.data
	if (props.editedFilterId) {
		filters = filters?.filter((f) => f.id !== props.editedFilterId)
	}
	const options = filters ? filters.map((f) => ({ label: f.name, value: f.id })) : LOADING
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
		column: M.StringColumn
		setValue: (value: T | undefined) => void
		autocompleteFilter?: M.FilterNode
	},
	ref: React.ForwardedRef<ComboBoxHandle>
) {
	const valuesRes = useLayersGroupedBy({ columns: [props.column], filter: props.autocompleteFilter })
	const options = valuesRes.isSuccess ? valuesRes.data.map((r) => r[props.column]) : LOADING
	return (
		<ComboBox
			ref={ref}
			allowEmpty={true}
			title={props.column}
			value={props.value}
			options={options}
			onSelect={(v) => props.setValue(v as T | undefined)}
		/>
	)
})

const StringEqConfigLimitedAutocomplete = React.forwardRef(function StringEqConfigLimitedAutocomplete<T extends string | null>(
	props: {
		value: T | undefined
		column: M.StringColumn
		setValue: (value: T | undefined) => void
		autocompleteFilter?: M.FilterNode
	},
	ref: React.ForwardedRef<ComboBoxHandle>
) {
	const autocomplete = useDynamicColumnAutocomplete(props.column, props.value, props.autocompleteFilter)
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
		/>
	)
})

const StringLikeConfig = React.forwardRef(function StringLikeConfig(
	props: { value: string; setValue: (value: string) => void },
	ref: React.ForwardedRef<Focusable>
) {
	const debouncer = useDebounced({
		defaultValue: () => props.value,
		onChange: props.setValue,
		delay: 500,
	})
	function setInputValue(value: string) {
		debouncer.setValue(value)
	}
	const inputRef = React.useRef<HTMLInputElement>(null)

	React.useImperativeHandle(ref, () => ({
		focus: () => inputRef.current?.focus(),
		get isFocused() {
			return inputRef.current === document.activeElement
		},
	}))

	return <Input ref={inputRef} onChange={(e) => setInputValue(e.target.value)} />
})

function useDynamicColumnAutocomplete<T extends string | null>(column: M.StringColumn, value: T | undefined, filter?: M.FilterNode) {
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

	if (filter && debouncedInput !== '') {
		filter = FB.and([filter, buildLikeFilter(column, debouncedInput)])
	} else if (debouncedInput !== '') {
		filter = buildLikeFilter(column, debouncedInput)
	}

	const valuesRes = useLayersGroupedBy(
		{
			columns: [column],
			filter,
		},
		{
			enabled: debouncedInput !== '',
		}
	)
	let options: T[] | typeof LOADING = LOADING
	if (debouncedInput === '') options = []
	else if (debouncedInput && valuesRes.isSuccess) {
		options = valuesRes.data!.map((v) => v[column]) as T[]
	}

	return {
		inputValue,
		setInputValue,
		options,
	}
}

function buildLikeFilter(column: M.StringColumn, input: string): M.FilterNode {
	return FB.comp(FB.like(column, `%${input}%`))
}

const StringInConfig = React.forwardRef(function StringInConfig(
	props: {
		values: (string | null)[]
		column: M.StringColumn
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		autocompleteFilter?: M.FilterNode
	},
	ref: React.ForwardedRef<ComboBoxHandle>
) {
	const valuesRes = useLayersGroupedBy({
		columns: [props.column],
		filter: props.autocompleteFilter,
	})
	return (
		<ComboBoxMulti
			title={props.column}
			ref={ref}
			values={props.values}
			options={valuesRes.data?.map((r) => r[props.column]) ?? []}
			onSelect={props.setValues}
		/>
	)
})

const StringInConfigLimitAutoComplete = React.forwardRef(function StringInConfigLimitAutoComplete(
	props: {
		values: (string | null)[]
		column: M.StringColumn
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		autocompleteFilter?: M.FilterNode
	},
	ref: React.ForwardedRef<ComboBoxHandle>
) {
	const autocomplete = useDynamicColumnAutocomplete(props.column, props.values[0] ?? '', props.autocompleteFilter)
	return (
		<ComboBoxMulti
			title={props.column}
			ref={ref}
			values={props.values}
			options={autocomplete.options}
			onSelect={props.setValues as ComboBoxMultiProps['onSelect']}
			inputValue={autocomplete.inputValue}
			setInputValue={autocomplete.setInputValue}
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
		forwardedRef: React.ForwardedRef<Focusable>
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
	}
)

const NumericRangeConfig = React.forwardRef(function NumericRangeConfig(
	props: {
		range: [number | undefined, number | undefined]
		setValues: React.Dispatch<React.SetStateAction<[number | undefined, number | undefined]>>
	},
	ref: React.ForwardedRef<Focusable>
) {
	function setFirst(value: number | undefined) {
		props.setValues((values) => [value, values[1]])
	}
	function setSecond(value: number | undefined) {
		props.setValues((values) => [values[0], value])
	}

	return (
		<div className="flex w-[200px] items-center space-x-2">
			<NumericSingleValueConfig placeholder="min" value={props.range[0]} setValue={setFirst} />
			<span>to</span>
			<NumericSingleValueConfig placeholder="max" ref={ref} value={props.range[0]} setValue={setSecond} />
		</div>
	)
})

const HasAllConfig = React.forwardRef(function HasAllConfig(
	props: {
		values: string[]
		column: M.CollectionColumn
		setValues: React.Dispatch<React.SetStateAction<string[]>>
		autocompleteFilter?: M.FilterNode
	},
	ref: React.ForwardedRef<ComboBoxHandle>
) {
	const factions1Res = useLayersGroupedBy({
		columns: ['Faction_1', 'SubFac_1'],
		filter: props.autocompleteFilter,
	})
	const factions2Res = useLayersGroupedBy({
		columns: ['Faction_2', 'SubFac_2'],
		filter: props.autocompleteFilter,
	})

	const mirrorCheckboxId = React.useId()
	const [mirror, setMirror] = useState(false)

	if (props.column === 'FactionMatchup') {
		const onSelect = props.setValues as ComboBoxMultiProps['onSelect']
		const allFactions = [
			...new Set([...(factions1Res.data?.map((r) => r.Faction_1) ?? []), ...(factions2Res.data?.map((r) => r.Faction_2) ?? [])]),
		]
		return (
			<ComboBoxMulti title={props.column} ref={ref} values={props.values} options={allFactions} onSelect={onSelect} selectionLimit={2} />
		)
	}

	if (props.column === 'SubFacMatchup') {
		const allSubFactions = [
			...new Set([...(factions1Res.data?.map((r) => r.SubFac_1) ?? []), ...(factions2Res.data?.map((r) => r.SubFac_2) ?? [])]),
		]

		function canMirror(values: string[]) {
			return values.length === 1 || (values.length === 2 && values[0] === values[1])
		}

		const onSelect: ComboBoxMultiProps['onSelect'] = (updater) => {
			props.setValues((currentValues) => {
				const newValues = (typeof updater === 'function' ? updater(currentValues) : updater) as string[]
				if (!canMirror(newValues)) {
					setMirror(false)
				}
				if (canMirror(newValues) && mirror) {
					return [newValues[0], newValues[0]]
				}
				return newValues
			})
		}
		return (
			<div className="flex space-x-2">
				<ComboBoxMulti
					title={props.column}
					ref={ref}
					values={mirror ? props.values.slice(1) : props.values}
					options={allSubFactions}
					onSelect={onSelect}
					selectionLimit={mirror ? undefined : 2}
				/>
				<div className="items-top flex space-x-1 items-center">
					<Checkbox
						checked={mirror}
						disabled={!canMirror(props.values)}
						onCheckedChange={(v) => {
							if (v === 'indeterminate' || !canMirror(props.values)) return
							if (v) {
								props.setValues([props.values[0], props.values[0]])
							} else {
								props.setValues([props.values[0]])
							}
							setMirror(v)
						}}
						id={mirrorCheckboxId}
					/>
					<label
						htmlFor={mirrorCheckboxId}
						className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
					>
						Mirror
					</label>
				</div>
			</div>
		)
	}

	if (props.column === 'FullMatchup') {
		const allFullTeams = [
			...new Set([
				...(factions1Res.data?.map((r) => M.getLayerTeamString(r.Faction_1, r.SubFac_1)) ?? []),
				...(factions2Res.data?.map((r) => M.getLayerTeamString(r.Faction_2, r.SubFac_2)) ?? []),
			]),
		]

		const allTeamOptions: ComboBoxOption<string>[] = allFullTeams.map((team) => {
			const { faction, subfac } = M.parseTeamString(team)
			return { value: team, label: [faction, subfac].join(' ') }
		})

		const onSelect = props.setValues as ComboBoxMultiProps['onSelect']
		return (
			<ComboBoxMulti title={props.column} ref={ref} values={props.values} selectionLimit={2} options={allTeamOptions} onSelect={onSelect} />
		)
	}

	assertNever(props.column)
})
