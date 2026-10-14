import { useNavigate } from '@tanstack/react-router'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as F_Msgs from '@/messages/filter.messages'
import * as F from '@/models/filter.models'
import * as FilterActions from '@/systems/filter-actions.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

// copies a filter under an id and name chosen here, then opens the copy
export function CloneFilterDialog(props: { source: F.FilterEntity; onClose: () => void }) {
	const navigate = useNavigate()
	const filterEntities = FilterEntityClient.useFilterEntities()
	const defaultId = F.cloneId(new Set(filterEntities.keys()), props.source.id)
	const idRef = React.useRef<HTMLInputElement>(null)
	const nameRef = React.useRef<HTMLInputElement>(null)
	const [submitting, setSubmitting] = React.useState(false)
	const [idError, setIdError] = React.useState<string | null>(null)
	const id = React.useId()

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		const newId = idRef.current?.value.trim() ?? ''
		const name = nameRef.current?.value.trim() ?? ''
		const idRes = F.FilterEntityIdSchema.safeParse(newId)
		setIdError(idRes.success ? null : (idRes.error.issues[0]?.message ?? null))
		if (!idRes.success || name.length < 3) return
		setSubmitting(true)
		try {
			const opened = await FilterActions.Actions.clone(props.source, { id: newId, name }, async () => {
				await navigate({ to: '/filters/$filterId', params: { filterId: newId } })
			})
			if (opened) props.onClose()
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{tr.text(F_Msgs.cloneTitle())}</DialogTitle>
						<DialogDescription>{tr.text(F_Msgs.cloneBlurb(props.source.name))}</DialogDescription>
					</DialogHeader>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-name`}>{tr.text(F_Msgs.cloneNameLabel())}</Label>
						<Input
							id={`${id}-name`}
							ref={nameRef}
							defaultValue={F.cloneName(props.source.name)}
							required
							minLength={3}
							maxLength={128}
							autoFocus
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-id`}>{tr.text(F_Msgs.cloneIdLabel())}</Label>
						<Input
							id={`${id}-id`}
							ref={idRef}
							defaultValue={defaultId}
							required
							minLength={3}
							maxLength={64}
							aria-invalid={idError !== null}
							className="font-mono"
						/>
						{idError && <p className="text-xs text-destructive">{idError}</p>}
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={props.onClose}>
							{tr.text(F_Msgs.cancel())}
						</Button>
						<Button submitChord="manual" type="submit" variant="primary" disabled={submitting}>
							{tr.text(F_Msgs.cloneAndOpen())}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
