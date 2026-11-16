import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as F from '@/models/filter.models'
import * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'
import * as RotationClient from '@/systems/rotation.client'

// Copies a rotation and opens the copy. The ID follows the name until it is edited by hand.
export function CloneRotationDialog(props: {
	source: Pick<ROT.Meta, 'id' | 'name'>
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-md">{props.open && <CloneForm {...props} />}</DialogContent>
		</Dialog>
	)
}

// the form opens once the copy's ID is known, so the ID field starts out filled in
function CloneForm(props: { source: Pick<ROT.Meta, 'id' | 'name'>; onOpenChange: (open: boolean) => void }) {
	const cloneId = useQuery(RotationClient.suggestCloneIdQuery(props.source.id))
	if (!cloneId.data) return null
	return <CloneFormLoaded {...props} cloneId={cloneId.data} />
}

function CloneFormLoaded(props: { source: Pick<ROT.Meta, 'id' | 'name'>; cloneId: ROT.RotationId; onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate()
	const nameRef = React.useRef<HTMLInputElement>(null)
	const idRef = React.useRef<HTMLInputElement>(null)
	const idTouched = React.useRef(false)
	const [copyTags, setCopyTags] = React.useState(true)
	const [copyContributors, setCopyContributors] = React.useState(false)
	const [submitting, setSubmitting] = React.useState(false)
	const formId = React.useId()

	const onNameChange = (name: string) => {
		if (idTouched.current || !idRef.current) return
		idRef.current.value = ROT.idFromName(name)
	}

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		const name = nameRef.current?.value.trim() ?? ''
		const id = idRef.current?.value.trim() ?? ''
		if (!ROT.NameSchema.safeParse(name).success || !ROT.NewRotationIdSchema.safeParse(id).success) return
		setSubmitting(true)
		let ok: boolean
		try {
			ok = await RotationClient.Actions.clone({ sourceId: props.source.id, id, name, copyTags, copyContributors })
		} finally {
			setSubmitting(false)
		}
		if (!ok) return
		props.onOpenChange(false)
		void navigate({ to: '/rotations/$rotationId', params: { rotationId: id } })
	}

	return (
		<form onSubmit={submit} className="space-y-4">
			<DialogHeader>
				<DialogTitle>{tr.text(ROT_Msgs.cloneTitle())}</DialogTitle>
				<DialogDescription>{tr.text(ROT_Msgs.cloneBlurb(props.source.name))}</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor={`${formId}-name`}>{tr.text(ROT_Msgs.name())}</Label>
				<Input
					id={`${formId}-name`}
					ref={nameRef}
					defaultValue={F.cloneName(props.source.name)}
					required
					minLength={3}
					maxLength={128}
					autoFocus
					onChange={(e) => onNameChange(e.target.value)}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={`${formId}-id`}>{tr.text(ROT_Msgs.id())}</Label>
				<Input
					id={`${formId}-id`}
					ref={idRef}
					defaultValue={props.cloneId}
					required
					pattern="[a-z0-9_\-]+"
					maxLength={64}
					className="font-mono"
					onChange={() => {
						idTouched.current = true
					}}
				/>
				<p className="text-xs text-muted-foreground">{tr.text(ROT_Msgs.idHelp())}</p>
			</div>
			<div className="space-y-2">
				<label className="flex items-center gap-2 text-sm">
					<Checkbox checked={copyTags} onCheckedChange={(checked) => setCopyTags(checked)} />
					{tr.text(ROT_Msgs.copyTags())}
				</label>
				<label className="flex items-center gap-2 text-sm">
					<Checkbox checked={copyContributors} onCheckedChange={(checked) => setCopyContributors(checked)} />
					{tr.text(ROT_Msgs.copyContributors())}
				</label>
			</div>
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
				<Button submitChord="manual" type="submit" variant="primary" disabled={submitting}>
					{tr.text(ROT_Msgs.cloneAndOpen())}
				</Button>
			</DialogFooter>
		</form>
	)
}

export function DeleteRotationDialog(props: {
	rotation: Pick<ROT.Meta, 'id' | 'name'>
	open: boolean
	onOpenChange: (open: boolean) => void
	onDeleted?: () => void
}) {
	return (
		<AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{tr.text(ROT_Msgs.deleteConfirmTitle(props.rotation.name))}</AlertDialogTitle>
					<AlertDialogDescription>{tr.text(ROT_Msgs.deleteConfirmBody())}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{tr.text(UI_Msgs.cancel())}</AlertDialogCancel>
					<AlertDialogAction
						submitChord
						variant="destructive"
						onClick={async () => {
							if (await RotationClient.Actions.remove(props.rotation)) props.onDeleted?.()
						}}
					>
						<Icons.Trash />
						{tr.text(ROT_Msgs.deleteRotation())}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
