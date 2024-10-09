import { Input } from '@/components/ui/input'
import { SetState } from '@/lib/react'
import { capitalize } from '@/lib/text'
import * as Typography from '@/lib/typography'
import * as M from '@/models.ts'
import { useForm } from '@tanstack/react-form'
import { FormEvent, useRef, useState } from 'react'

import { FilterNodeDisplay } from './filter-card'
import LayerTable from './layer-table'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTrigger } from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

const defaultFilter: M.EditableFilterNode = {
	type: 'and',
	children: [],
}

export default function FilterNew() {
	const [filter, _setFilter] = useState(defaultFilter)
	const [validFilter, setValidFilter] = useState(null as M.FilterNode | null)
	const [pageIndex, setPageIndex] = useState(0)
	const setFilter = (update: (prev: M.EditableFilterNode) => M.EditableFilterNode) => {
		const newFilter = update(filter)
		if (newFilter.type === 'and' && newFilter.children.length === 0) {
			setValidFilter(null)
		} else if (M.isValidFilterNode(newFilter)) {
			setValidFilter(newFilter)
		} else {
			setValidFilter(null)
		}
		setPageIndex(0)
		_setFilter(newFilter)
	}

	return (
		<div className="container mx-auto py-10">
			<div className="flex space-x-2">
				<FilterNodeDisplay node={filter} setNode={setFilter as SetState<M.EditableFilterNode | undefined>} depth={0} />
				<div className="flex flex-col space-y-2">
					<CreateFilterPopover>
						<Button>Create</Button>
					</CreateFilterPopover>
				</div>
			</div>
			<LayerTable filter={validFilter ?? undefined} pageIndex={pageIndex} setPageIndex={setPageIndex} />
		</div>
	)
}

function CreateFilterPopover(props: { children: React.ReactNode; filter?: M.FilterNode }) {
	const form = useForm({
		defaultValues: {
			id: '',
			name: '',
			description: '',
		},
		onSubmit: async ({ value }) => {
			console.log(value)
		},
	})

	function onSubmit(e: FormEvent) {
		if (props.filter) throw new Error('filter must be defined')
		e.preventDefault()
		e.stopPropagation()
		form.handleSubmit()
	}
	const fieldClasses = 'flex flex-col space-y-2'
	const nameRef = useRef<HTMLInputElement>(null)
	function onNameChange(name: string) {
		form.setFieldValue('name', name)
		// check if id field is dirty
		const isIdDirty = form.getFieldMeta('id')?.isDirty
		if (!isIdDirty) {
			form.setFieldValue('id', name.toLowerCase().replace(/\s+/g, '-'), { dontUpdateMeta: true })
		}
	}
	function onOpenChange(isOpen: boolean) {
		if (isOpen) {
			nameRef.current?.focus()
		} else {
			form.reset()
		}
	}

	return (
		<Dialog onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="items-center flex flex-col">
				<h3 className={Typography.H3 + ' mx-auto'}>Submit New Filter</h3>
				<form onSubmit={onSubmit} className="flex flex-col space-y-4">
					<div className="flex items-center space-x-2">
						<form.Field
							name="name"
							children={(field) => {
								return (
									<div className={fieldClasses}>
										<Label htmlFor={field.name}>{capitalize(field.name)}</Label>
										<Input
											ref={nameRef}
											id={field.name}
											name={field.name}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => onNameChange(e.target.value)}
										/>
									</div>
								)
							}}
						/>
						<form.Field
							name="id"
							children={(field) => {
								return (
									<div className={fieldClasses}>
										<Label htmlFor={field.name}>{capitalize(field.name)}</Label>
										<Input
											id={field.name}
											name={field.name}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
									</div>
								)
							}}
						/>
					</div>
					<form.Field
						name="description"
						children={(field) => {
							return (
								<div className={fieldClasses}>
									<Label htmlFor={field.name}>{capitalize(field.name)}</Label>
									<Textarea
										id={field.name}
										name={field.name}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
								</div>
							)
						}}
					/>
					<div className="flex items-center justify-end">
						<Button type="submit">Submit</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
