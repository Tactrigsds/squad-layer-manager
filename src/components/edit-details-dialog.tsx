import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import * as ValidationErrors from '@/lib/validation-errors'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'
import type * as RbacClient from '@/systems/rbac.client'

// The pencil beside an entity's name, and the dialog it opens to edit the entity's name, description and other details.

export function EditDetailsButton(props: { denied: ReturnType<typeof RbacClient.usePermsCheck>; onClick: () => void }) {
	const label = tr.text(UI_Msgs.editDetails())
	return (
		<PermissionDeniedTooltip denied={props.denied}>
			<Button aria-label={label} title={label} disabled={!!props.denied} onClick={props.onClick} variant="ghost" size="icon">
				<Icons.Edit />
			</Button>
		</PermissionDeniedTooltip>
	)
}

// `children` is mounted only while the dialog is open, so a form inside it starts from the current details each time.
export function EditDetailsDialog(props: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title?: string
	description?: string
	className?: string
	children: React.ReactNode
}) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className={cn('max-w-2xl', props.className)}>
				<DialogHeader>
					<DialogTitle>{props.title ?? tr.text(UI_Msgs.editDetails())}</DialogTitle>
					{props.description && <DialogDescription>{props.description}</DialogDescription>}
				</DialogHeader>
				{props.open && props.children}
			</DialogContent>
		</Dialog>
	)
}

// the form element of an EditDetailsDialog, with its fields scrolling above Cancel and the submit button
export function EditDetailsForm(props: {
	onSubmit: () => void
	onCancel: () => void
	submitLabel: string
	submitDisabled: boolean
	className?: string
	children: React.ReactNode
}) {
	return (
		<form
			className="flex min-h-0 flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				props.onSubmit()
			}}
		>
			<div className={cn('min-h-0 overflow-y-auto p-0.5', props.className)}>{props.children}</div>
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={props.onCancel}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
				<Button submitChord="manual" type="submit" variant="primary" disabled={props.submitDisabled}>
					{props.submitLabel}
				</Button>
			</DialogFooter>
		</form>
	)
}

export function FieldErrors(props: { label?: string; errors: unknown[] }) {
	if (props.errors.length === 0) return null
	return (
		<Alert variant="destructive">
			{props.label && <AlertTitle>{props.label}:</AlertTitle>}
			<AlertDescription>{ValidationErrors.formatFieldErrors(props.errors)}</AlertDescription>
		</Alert>
	)
}

const MARKDOWN_SYNTAX_URL = 'https://commonmark.org/help/'

const trWithMarkdownLink = tr.withTags({
	link: (chunks) => (
		<a href={MARKDOWN_SYNTAX_URL} target="_blank" rel="noopener noreferrer">
			{chunks}
		</a>
	),
})

export function MarkdownHint(props: { id: string }) {
	return (
		<p id={props.id} className="text-xs text-muted-foreground [&_a]:text-info [&_a]:hover:underline">
			{trWithMarkdownLink.richText(UI_Msgs.markdownHint())}
		</p>
	)
}
