import { SetState } from '@/lib/react'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { produce } from 'immer'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'

import { Button } from './ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export function FilterCard({ filter, setFilter }: { filter: M.EditableFilterNode; setFilter: SetState<M.EditableFilterNode> }) {
	return <FilterNodeDisplay node={filter} setNode={setFilter} />
}

const nodeWrapper = 'p-2 border-l-2 border-gray-300 space-x-2 w-full flex nowrap'

function FilterNodeDisplay(props: { node: M.EditableFilterNode; setNode: SetState<M.EditableFilterNode> }) {
	const { node, setNode } = props

	if (node.type === 'and' || node.type === 'or') {
		const children = node.children?.map((child, i) => {
			const setChild: SetState<M.EditableFilterNode> = (cb) => {
				setNode((s) => {
					if (s.type !== 'and' && s.type !== 'or') return s
					if (!s.children[i]) return s
					return produce(s, (draft) => {
						draft.children[i] = cb(s.children[i])
					})
				})
			}

			return <FilterNodeDisplay key={i} node={child} setNode={setChild} />
		})
		const addNewChild = (type: M.EditableFilterNode['type']) => {
			setNode((s) =>
				produce(s, (draft) => {
					if (draft.type !== 'and' && draft.type !== 'or') return
					if (type === 'comp') draft.children.push({ type, comp: {} })
					if (type === 'and' || type === 'or') draft.children.push({ type, children: [] })
				})
			)
		}

		return (
			<div className={cn(nodeWrapper, 'flex-col space-x-0 space-y-2')}>
				{children!}
				<span>
					<Button className="min-h-0" onClick={() => addNewChild('comp')}>
						Add
					</Button>
				</span>
			</div>
		)
	}
	const setComp: SetState<M.EditableComparison> = (cb) => {
		setNode((s) => {
			const out = produce(s, (draft) => {
				if (draft.type !== 'comp') return
				draft.comp = cb(draft.comp)
			})
			return out
		})
	}

	if (node.type === 'comp' && node.comp) {
		return <Comparison comp={node.comp} setComp={setComp} />
	}

	throw new Error('Invalid node type ' + node.type)
}

function Comparison(props: { comp: M.EditableComparison; setComp: SetState<M.EditableComparison> }) {
	const { comp, setComp } = props
	const columnBox = (
		<ComboBox title="Column" value={comp.column} options={M.COLUMN_KEYS} onSelect={(column) => setComp(() => ({ column }))} />
	)
	if (!comp.column) return <div className={nodeWrapper}>{columnBox}</div>
	console.log('value comp', comp.value)
	return (
		<div className={nodeWrapper}>
			{columnBox}
			<ComboBox
				className="w-[100px]"
				title=""
				value={comp.code}
				options={M.getComparisonTypesForColumn(comp.column).map((c) => c.code)}
				onSelect={(code) => setComp((c) => ({ column: c.column, code }))}
			/>
			{comp.code === 'eq' && (
				<StringEqConfig
					column={comp.column as M.StringColumn}
					value={comp.value as string | undefined}
					setValue={(value) => setComp((c) => ({ ...c, value }))}
				/>
			)}
			{comp.code === 'in' && (
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
			{(comp.code === 'gt' || comp.code === 'lt') && (
				<NumericSingleValueConfig
					class="w-[200px]"
					value={comp.value as number | undefined}
					setValue={(value) => setComp((c) => ({ ...c, value }))}
				/>
			)}
			{comp.code === 'inrange' && (
				<NumericRangeConfig
					min={comp.min as number | undefined}
					max={comp.max as number | undefined}
					setMin={(min) => setComp((c) => ({ ...c, min }))}
					setMax={(max) => setComp((c) => ({ ...c, max }))}
				/>
			)}
		</div>
	)
}

function StringEqConfig(props: { value: string | undefined; column: M.StringColumn; setValue: (value: string | undefined) => void }) {
	const { column, value, setValue } = props
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(column)
	return <ComboBox title="" value={value} options={valuesRes.data ?? []} onSelect={setValue} />
}

function StringInConfig(props: { values: string[]; column: M.StringColumn; setValues: SetState<string[]> }) {
	const { column, values, setValues } = props
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(column)
	return <ComboBoxMulti values={values} options={valuesRes.data ?? []} onSelect={setValues} />
}

function NumericSingleValueConfig(props: { class?: string; value?: number; setValue: (value?: number) => void }) {
	const [value, setValue] = useState(props.value?.toString() ?? '')
	return (
		<Input
			className={props.class}
			value={value}
			onChange={(e) => {
				setValue(e.target.value)
				const value = e.target.value.trim()
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

function ComboBox<T extends string>(props: { className?: string; title: string; value?: T; options: T[]; onSelect: (value: T) => void }) {
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} className={cn('w-[200px] justify-between', props.className)}>
					{props.value ? props.value : `Select ${props.title}...`}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0">
				<Command>
					<CommandInput placeholder={`Search ${props.title}...`} />
					<CommandList>
						<CommandEmpty>No framework found.</CommandEmpty>
						<CommandGroup>
							{props.options.map((option) => (
								<CommandItem key={option} value={option} onSelect={props.onSelect as (value: string) => void}>
									<Check className={cn('mr-2 h-4 w-4', props.value === option ? 'opacity-100' : 'opacity-0')} />
									{option}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

function ComboBoxMulti<T extends string>(props: { values: T[]; options: T[]; onSelect: SetState<T[]> }) {
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
									value={option}
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
									{option}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
