import { SetState } from '@/lib/react'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import { produce } from 'immer'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'

import { Button } from './ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const defaultFilter: M.FilterNode = {
	type: 'and',
	children: [
		{
			type: 'comp',
			comp: {
				column: 'Level',
				code: 'eq',
				value: 'AlBasrah',
			},
		},
		{
			type: 'comp',
			comp: {
				code: 'eq',
				column: 'Faction_2',
				value: 'RAAS',
			},
		},
	],
}

export function FilterCard() {
	const [filter, setFilter] = useState(defaultFilter)
	return <FilterNodeDisplay node={filter} setNode={setFilter} />
}

const nodeWrapper = 'p-2 border-l-2 border-gray-300 w-max h-max'

function FilterNodeDisplay(props: { node: M.EditableFilterNode; setNode: SetState<M.EditableFilterNode> }) {
	const { node, setNode } = props
	const [newComparison, setNewComparison] = useState(null as null | Partial<M.EqualComparison>)

	if (node.type === 'and' || node.type === 'or') {
		const children = node.children?.map((child, i) => {
			const setChild: SetState<M.FilterNode> = (cb) => {
				setNode((s) =>
					produce(s, (draft) => {
						if (node.type !== 'and' || node.type !== 'or') return
						if (!draft.children[i]) return
						draft.children[i] = cb(draft.children[i])
					})
				)
			}

			return <FilterNodeDisplay key={i} node={child} setNode={setChild} />
		})
		return (
			<div className={nodeWrapper}>
				{children!}
				{newComparison ? (
					<Comparison comp={newComparison} setComp={setNewComparison} />
				) : (
					<Button onClick={() => setNewComparison({})}>Add</Button>
				)}
			</div>
		)
	}

	if (node.type === 'comp' && node.comp) {
		return <Comparison comp={node.comp} setComp={setNode as SetState<Partial<M.Comparison>>} />
	}

	throw new Error('Invalid node type ' + node.type)
}

function Comparison(props: { comp: M.EditableComparison; setComp: SetState<M.EditableComparison> }) {
	const { comp, setComp } = props
	const columnBox = (
		<ComboBox
			value={comp.column ?? null}
			options={M.COLUMN_KEYS}
			onSelect={(column) => setComp(() => ({ column }) as Partial<M.Comparison>)}
		/>
	)
	if (!comp.column) return <div>{columnBox}</div>
	return (
		<div>
			{columnBox}
			<ComboBox
				value={comp.code ?? null}
				options={M.getComparisonTypesForColumn(comp.column).map((c) => c.code)}
				onSelect={(code) => setComp((c) => ({ column: c.column, code }) as M.EditableComparison)}
			/>
			{comp.code === 'eq' && (
				<StringEqConfig
					column={comp.column as M.StringColumn}
					value={(comp.value ?? null) as string | null}
					setValue={(value) => setComp((c) => ({ ...c, value }) as M.EditableComparison)}
				/>
			)}
		</div>
	)
}

// function StringEqValueConfig(props: { comp: M.StringComparison; setComp: SetState<M.StringComparison> }) {
// 	const { comp, setComp } = props
// 	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(comp.column)
// 	const setColumn = (column: M.LayerKey) => (setComp as SetState<M.Comparison>)((c) => ({ ...c, column: column }))
// 	const setCode = (code: string) => (setComp as SetState<M.Comparison>)((c) => ({ ...c, code }))
// 	const options = valuesRes.data ? valuesRes.data : []
// 	return <EqConfig comp={comp as M.EqualComparison} setComp={setComp as SetState<M.EqualComparison>} options={options} />
// }
function StringEqConfig(props: { value: string | null; column: M.StringColumn; setValue: (value: string) => void }) {
	const { column, value, setValue } = props
	const valuesRes = trpc.getColumnUniqueColumnValues.useQuery(column)
	return <ComboBox value={value} options={valuesRes.data ?? []} onSelect={setValue} />
}

function ComboBox<T extends string>(props: { value: T | null; options: T[]; onSelect: (value: T) => void }) {
	const { value, onSelect, options } = props
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} className="w-[200px] justify-between">
					{props.value ? props.value : 'Select...'}
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
								<CommandItem key={option} value={option} onSelect={onSelect}>
									<Check className={cn('mr-2 h-4 w-4', value === option ? 'opacity-100' : 'opacity-0')} />
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
