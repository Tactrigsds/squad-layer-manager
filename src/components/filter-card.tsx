import { SetState } from '@/lib/react'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { produce } from 'immer'
import { Check, ChevronsUpDown, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from './ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export function FilterCard({ filter, setFilter }: { filter: M.EditableFilterNode; setFilter: SetState<M.EditableFilterNode> }) {
	return <FilterNodeDisplay node={filter} setNode={setFilter as SetState<M.EditableFilterNode | undefined>} depth={0} />
}

const depthColors = ['border-red-500', 'border-green-500', 'border-blue-500', 'border-yellow-500']
function getNodeWrapperClasses(depth: number, invalid: boolean) {
	const base = 'p-2 border-l-2 w-full'
	const depthColor = depth === 0 ? 'border-secondary' : depthColors[depth % depthColors.length]
	const validColor = invalid ? 'bg-red-400/10' : ''
	return cn(base, depthColor, validColor)
}

function FilterNodeDisplay(props: { node: M.EditableFilterNode; setNode: SetState<M.EditableFilterNode | undefined>; depth: number }) {
	const { node, setNode } = props
	const isValid = M.isLocallyValidFilterNode(node, props.depth)
	console.log('node at depth ', props.depth, node, 'valid: ', isValid)
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
							<DropdownMenuItem onClick={() => addNewChild('and')}>and</DropdownMenuItem>
							<DropdownMenuItem onClick={() => addNewChild('or')}>or</DropdownMenuItem>
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

function Comparison(props: { comp: M.EditableComparison; setComp: SetState<M.EditableComparison> }) {
	const { comp, setComp } = props
	const columnBox = (
		<ComboBox title="Column" value={comp.column} options={M.COLUMN_KEYS} onSelect={(column) => setComp(() => ({ column }))} />
	)

	if (!comp.column) return columnBox
	return (
		<>
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

function StringEqConfig(props: { value: string | undefined; column: M.StringColumn; setValue: (value: string | undefined) => void }) {
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(props.column)
	return <ComboBox title={props.column} value={props.value} options={valuesRes.data ?? []} onSelect={props.setValue} />
}

function StringInConfig(props: { values: string[]; column: M.StringColumn; setValues: SetState<string[]> }) {
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(props.column)
	return <ComboBoxMulti values={props.values} options={valuesRes.data ?? []} onSelect={props.setValues} />
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
