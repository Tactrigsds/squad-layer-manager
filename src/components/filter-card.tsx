import { useDebounced } from '@/hooks/use-debounce'
import { sleepUntil } from '@/lib/async'
import { SetState } from '@/lib/react'
import { trpcReact } from '@/lib/trpc.client.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { produce } from 'immer'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import React from 'react'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox, { ComboBoxHandle } from './combo-box/combo-box.tsx'
import { LOADING } from './combo-box/constants.ts'
import { Button, buttonVariants } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'

const depthColors = ['border-red-500', 'border-green-500', 'border-blue-500', 'border-yellow-500']
function getNodeWrapperClasses(depth: number, invalid: boolean) {
	const base = 'p-2 border-l-2 w-full'
	const depthColor = depth === 0 ? 'border-secondary' : depthColors[depth % depthColors.length]
	const validColor = invalid ? 'bg-red-400/10' : ''
	return cn(base, depthColor, validColor)
}

export function FilterNodeDisplay(props: {
	defaultEditing?: boolean
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
	const [editedChildIndex, setEditedChildIndex] = useState<number | undefined>()

	if (node.type === 'and' || node.type === 'or') {
		const childrenLen = node.children.length
		const children = node.children?.map((child, i) => {
			const setChild: SetState<M.EditableFilterNode | undefined> = (cb) => {
				setNode(
					produce((draft) => {
						if (!draft || (draft.type !== 'and' && draft.type !== 'or') || draft.children.length !== childrenLen) {
							return
						}
						const newValue = cb(draft.children[i])
						if (newValue) draft.children[i] = newValue
						else draft.children.splice(i, 1)
					})
				)
			}

			return <FilterNodeDisplay defaultEditing={editedChildIndex === i} depth={props.depth + 1} key={i} node={child} setNode={setChild} />
		})
		const addNewChild = (type: M.EditableFilterNode['type']) => {
			setNode(
				produce((draft) => {
					if (!draft || (draft.type !== 'and' && draft.type !== 'or')) {
						setEditedChildIndex(undefined)
						return
					}
					setEditedChildIndex(draft.children.length)
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
				<Comparison defaultEditing={props.defaultEditing} comp={node.comp} setComp={setComp} />
				<Button size="icon" variant="ghost" onClick={() => setNode(() => undefined)}>
					<Minus color="hsl(var(--destructive))" />
				</Button>
			</div>
		)
	}

	throw new Error('Invalid node type ' + node.type)
}
const LIMIT_AUTOCOMPLETE_COLS: M.LayerColumnKey[] = ['id']

export function Comparison(props: {
	comp: M.EditableComparison
	setComp: SetState<M.EditableComparison>
	columnEditable?: boolean
	valueAutocompleteFilter?: M.FilterNode
	defaultEditing?: boolean
}) {
	const { comp, setComp } = props
	let { columnEditable } = props
	columnEditable ??= true
	const columnBoxRef = useRef<ComboBoxHandle>(null)
	const codeBoxRef = useRef<ComboBoxHandle>(null)
	const valueBoxRef = useRef<ComboBoxHandle>(null)
	const alreadyOpenedRef = useRef(false)
	useEffect(() => {
		if (props.defaultEditing && !columnBoxRef.current!.isOpen && !alreadyOpenedRef.current) {
			columnBoxRef.current?.open()
			alreadyOpenedRef.current = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const columnBox = columnEditable ? (
		<ComboBox
			title="Column"
			allowEmpty={true}
			value={comp.column}
			options={M.COLUMN_KEYS}
			ref={columnBoxRef}
			onSelect={(column) => {
				if (column && M.COLUMN_KEY_TO_TYPE[column as M.LayerColumnKey] === 'string') {
					setComp((c) => {
						let code = c.code && column in M.COLUMN_TYPE_MAPPINGS.string ? c.code : undefined
						if (!code) code = 'eq'
						return { column: column, code }
					})
					sleepUntil(() => valueBoxRef.current).then((handle) => handle?.open())
					return
				}
				if (column && M.COLUMN_KEY_TO_TYPE[column as M.LayerColumnKey] === 'float') {
					setComp((c) => {
						const code = c.code && column in M.COLUMN_TYPE_MAPPINGS.float ? c.code : undefined
						return { column: c.column, code }
					})
					valueBoxRef.current?.open()
					return
				}
				return setComp(() => ({ column: column }))
			}}
		/>
	) : (
		<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none')}>{comp.column}</span>
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
				ref={codeBoxRef}
				onSelect={(code) => {
					// instead of doing this cringe sleepUntil thing we could buffer events to send to newly created Config components and send them on mount, but I thought of that after coming up with this solution ¯\_(ツ)_/¯. flushSync is also an option but I don't think blocking this event on a react rerender is a good idea
					if (code !== undefined) sleepUntil(() => valueBoxRef.current).then((handle) => handle?.open())
					return setComp((c) => ({ ...c, code: code ?? undefined }))
				}}
			/>
			{comp.code === 'eq' && !LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringEqConfig
					ref={valueBoxRef}
					column={comp.column as M.StringColumn}
					value={comp.value as string | undefined | null}
					setValue={(value) => {
						return setComp((c) => ({ ...c, value }))
					}}
					autocompleteFilter={props.valueAutocompleteFilter}
				/>
			)}
			{comp.code === 'eq' && LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringEqConfigLimitedAutocomplete
					ref={valueBoxRef}
					column={comp.column as M.StringColumn}
					value={comp.value as string | undefined | null}
					setValue={(value) => {
						return setComp((c) => ({ ...c, value }))
					}}
					autocompleteFilter={props.valueAutocompleteFilter}
				/>
			)}
			{comp.code === 'in' && !LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringInConfig
					ref={valueBoxRef}
					column={comp.column as M.StringColumn}
					values={(comp.values ?? []) as string[]}
					autocompleteFilter={props.valueAutocompleteFilter}
					setValues={(getValues) => {
						setComp((c) => {
							return { ...c, values: getValues(c.values ?? []) }
						})
					}}
				/>
			)}
			{comp.code === 'in' && LIMIT_AUTOCOMPLETE_COLS.includes(comp.column) && (
				<StringInConfigLimitAutoComplete
					ref={valueBoxRef}
					column={comp.column as M.StringColumn}
					values={(comp.values ?? []) as string[]}
					autocompleteFilter={props.valueAutocompleteFilter}
					setValues={(getValues) => {
						setComp((c) => {
							return { ...c, values: getValues(c.values ?? []) }
						})
					}}
				/>
			)}
			{(comp.code === 'gt' || comp.code === 'lt') && (
				<NumericSingleValueConfig
					ref={valueBoxRef}
					className="w-[200px]"
					value={comp.value as number | undefined}
					setValue={(value) => {
						return setComp((c) => ({ ...c, value }))
					}}
				/>
			)}
			{comp.code === 'inrange' && (
				<NumericRangeConfig
					ref={valueBoxRef}
					min={comp.min}
					max={comp.max}
					setMin={(min) => {
						return setComp((c) => ({ ...c, min }))
					}}
					setMax={(max) => {
						setComp((c) => ({ ...c, max }))
					}}
				/>
			)}
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
	ref: React.MutableRefObject<ComboBoxHandle>
) {
	const valuesRes = trpcReact.getUniqueValues.useQuery({ columns: [props.column], filter: props.autocompleteFilter })
	const options = valuesRes.isSuccess ? valuesRes.data.map((r) => r[props.column]) : LOADING
	return (
		<ComboBox ref={ref} allowEmpty={true} title={props.column} value={props.value} options={options} onSelect={(v) => props.setValue(v)} />
	)
})

const StringEqConfigLimitedAutocomplete = React.forwardRef(function StringEqConfigLimitedAutocomplete<T extends string | null>(
	props: {
		value: T | undefined
		column: M.StringColumn
		setValue: (value: T | undefined) => void
		autocompleteFilter?: M.FilterNode
	},
	ref: React.MutableRefObject<ComboBoxHandle>
) {
	const autocomplete = useLimitedColumnAutocomplete(props.column, props.value, props.autocompleteFilter)
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

function useLimitedColumnAutocomplete<T extends string | null>(column: M.StringColumn, value: T | undefined, filter?: M.FilterNode) {
	const [debouncedInput, _setDebouncedInput] = useState('')
	const [inputValue, _setInputValue] = useState<string>(value?.split(',')[0] ?? '')
	function setDebouncedInput(value: string) {
		const v = value.trim() as T
		_setDebouncedInput(v)
	}
	const debouncer = useDebounced({ defaultValue: inputValue, onChange: setDebouncedInput, delay: 500 })
	function setInputValue(value: string) {
		_setInputValue(value)
		debouncer.setValue(value)
	}

	if (filter && debouncedInput !== '') {
		filter = {
			type: 'and',
			children: [filter, buildLikeFilter(column, debouncedInput)],
		}
	} else if (debouncedInput !== '') {
		filter = buildLikeFilter(column, debouncedInput)
	}

	const valuesRes = trpcReact.getUniqueValues.useQuery(
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
	else if (debouncedInput && valuesRes.isSuccess) options = valuesRes.data!.map((v) => v[column])

	return {
		inputValue,
		setInputValue,
		options,
	}
}

function buildLikeFilter(column: M.StringColumn, input: string): M.FilterNode {
	return {
		type: 'comp',
		comp: {
			code: 'like',
			column: column,
			value: `%${input}%`,
		},
	}
}

const StringInConfig = React.forwardRef(function StringInConfig(
	props: {
		values: string[]
		column: M.StringColumn
		setValues: React.Dispatch<React.SetStateAction<string[]>>
		autocompleteFilter?: M.FilterNode
	},
	ref: React.MutableRefObject<ComboBoxHandle>
) {
	const valuesRes = trpcReact.getUniqueValues.useQuery({ columns: [props.column], filter: props.autocompleteFilter, limit: 25 })
	return (
		<ComboBoxMulti
			title={props.column}
			ref={ref}
			values={props.values}
			options={valuesRes.data?.map((r) => r[props.column]) ?? []}
			onSelect={props.setValues as React.Dispatch<React.SetStateAction<(string | null)[]>>}
		/>
	)
})

const StringInConfigLimitAutoComplete = React.forwardRef(function StringInConfigLimitAutoComplete(
	props: {
		values: string[]
		column: M.StringColumn
		setValues: SetState<string[]>
		autocompleteFilter?: M.FilterNode
	},
	ref: React.MutableRefObject<ComboBoxHandle>
) {
	const autocomplete = useLimitedColumnAutocomplete(props.column, props.values[0] ?? '', props.autocompleteFilter)
	return (
		<ComboBoxMulti
			ref={ref}
			values={props.values}
			options={autocomplete.options}
			onSelect={props.setValues}
			inputValue={autocomplete.inputValue}
			setInputValue={autocomplete.setInputValue}
		/>
	)
})

const NumericSingleValueConfig = React.forwardRef(
	(props: { className?: string; value?: number; setValue: (value?: number) => void }, ref: React.Ref<HTMLInputElement>) => {
		const [value, setValue] = useState(props.value?.toString() ?? '')
		return (
			<Input
				ref={ref}
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
)

const NumericRangeConfig = React.forwardRef(function NumericRangeConfig(
	props: { min?: number; max?: number; setMin: (min?: number) => void; setMax: (max?: number) => void },
	ref: React.MutableRefObject<HTMLInputElement>
) {
	return (
		<div className="flex w-[200px] space-x-2 items-center">
			<NumericSingleValueConfig ref={ref} value={props.min} setValue={props.setMin} />
			<span>to</span>
			<NumericSingleValueConfig value={props.max} setValue={props.setMax} />
		</div>
	)
})
// can't use an actual symbol because cmdk doesn't support them afaik
