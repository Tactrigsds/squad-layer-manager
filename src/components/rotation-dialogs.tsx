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
import { Textarea } from '@/components/ui/textarea'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as F from '@/models/filter.models'
import * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

export type RotationFormMode = { mode: 'new' } | { mode: 'clone'; source: ROT.Rotation }

// Creates a rotation, or a copy of one, and opens it. The ID follows the name until it is edited by hand.
export function RotationFormDialog(props: RotationFormMode & { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-md">{props.open && <RotationForm {...props} />}</DialogContent>
		</Dialog>
	)
}

function RotationForm(props: RotationFormMode & { onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate()
	const rotations = Zus.useStore(RotationClient.Store, RotationClient.Sel.rotations)
	// the configured default, else the ruleset of the default server
	const defaultRepeatRulesetId = Zus.useStore(
		SettingsClient.PublicSettingsStore,
		(s) => s?.defaultRotationRepeatRulesetId ?? s?.servers.find((server) => server.defaultServer)?.repeatRulesetId ?? null,
	)
	const nameRef = React.useRef<HTMLInputElement>(null)
	const idRef = React.useRef<HTMLInputElement>(null)
	const descriptionRef = React.useRef<HTMLTextAreaElement>(null)
	const idTouched = React.useRef(false)
	const [copyTags, setCopyTags] = React.useState(true)
	const [copyContributors, setCopyContributors] = React.useState(false)
	const [submitting, setSubmitting] = React.useState(false)
	const formId = React.useId()

	const [defaults] = React.useState(() => {
		if (props.mode === 'new') return { name: '', id: '' }
		return { name: F.cloneName(props.source.name), id: F.cloneId(new Set(rotations.keys()), props.source.id) }
	})

	const onNameChange = (name: string) => {
		if (idTouched.current || !idRef.current) return
		idRef.current.value = ROT.idFromName(name)
	}

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		const name = nameRef.current?.value.trim() ?? ''
		const id = idRef.current?.value.trim() ?? ''
		if (!ROT.NameSchema.safeParse(name).success || !ROT.RotationIdSchema.safeParse(id).success) return
		setSubmitting(true)
		let ok: boolean
		try {
			ok =
				props.mode === 'new'
					? await RotationClient.Actions.create({
							id,
							name,
							description: descriptionRef.current?.value.trim() || null,
							repeatRulesetId: defaultRepeatRulesetId,
							tags: [],
						})
					: await RotationClient.Actions.clone({ sourceId: props.source.id, id, name, copyTags, copyContributors })
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
				<DialogTitle>{tr.text(props.mode === 'new' ? ROT_Msgs.newRotationTitle() : ROT_Msgs.cloneTitle())}</DialogTitle>
				{props.mode === 'clone' && <DialogDescription>{tr.text(ROT_Msgs.cloneBlurb(props.source.name))}</DialogDescription>}
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor={`${formId}-name`}>{tr.text(ROT_Msgs.name())}</Label>
				<Input
					id={`${formId}-name`}
					ref={nameRef}
					defaultValue={defaults.name}
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
					defaultValue={defaults.id}
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
			{props.mode === 'new' ? (
				<div className="space-y-1.5">
					<Label htmlFor={`${formId}-description`}>{tr.text(ROT_Msgs.description())}</Label>
					<Textarea id={`${formId}-description`} ref={descriptionRef} maxLength={2048} rows={3} />
				</div>
			) : (
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
			)}
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
				<Button type="submit" variant="primary" disabled={submitting}>
					{tr.text(props.mode === 'new' ? ROT_Msgs.create() : ROT_Msgs.cloneAndOpen())}
				</Button>
			</DialogFooter>
		</form>
	)
}

export function DeleteRotationDialog(props: {
	rotation: ROT.Rotation
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
