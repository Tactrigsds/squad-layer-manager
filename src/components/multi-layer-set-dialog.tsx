import * as Icons from 'lucide-react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as L from '@/models/layer.models'
import { tr } from '@/systems/messages.client'

import { describeLayerLine, type PastedLayers, usePastedLayers } from './multi-layer-set-dialog.helpers'

export type MultiLayerSetDialogProps = {
	onSubmit: (layers: L.UnvalidatedLayer[]) => void
	open?: boolean
	onOpenChange?: (open: boolean) => void
	trigger?: React.ReactNode
	title?: string
	extraFooter?: React.ReactNode
	// the collections the target server can load. Omit where no server answers for the paste
	installedMods?: readonly string[]
}

export function MultiLayerSetDialog(props: MultiLayerSetDialogProps) {
	const [internalOpen, setInternalOpen] = React.useState(false)
	const open = props.open ?? internalOpen
	const setOpenProp = props.onOpenChange ?? setInternalOpen
	const pasted = usePastedLayers(props.installedMods)
	const { errors, layers, pending } = pasted

	// the textarea unmounts with the dialog, so the lines parsed from it go too
	function setOpen(open: boolean) {
		if (!open) pasted.reset()
		setOpenProp(open)
	}

	function handleSubmit() {
		// the text stays put on a rejected paste: the user has to be able to see and fix the offending lines
		if (errors.length > 0 || pending || layers.length === 0) return
		props.onSubmit(layers)
		setOpen(false)
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{props.trigger && <DialogTrigger asChild>{props.trigger}</DialogTrigger>}
			<DialogContent className="max-w-lg min-w-[min(700px,70vw)]">
				<DialogHeader>
					<DialogTitle>{props.title ?? tr.text(L_Msgs.addMultipleLayers())}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<PastedLayersFields pasted={pasted} />
					<div className="flex justify-end space-x-2">
						{props.extraFooter}
						<Button variant="outline" onClick={() => setOpen(false)}>
							{tr.text(UI_Msgs.cancel())}
						</Button>
						<Button
							submitChord
							variant="primary"
							onClick={handleSubmit}
							disabled={layers.length === 0 || errors.length > 0 || pending}
						>
							{tr.text(L_Msgs.addLayers(layers.length))}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

// the textarea, the validation switch and the lines that block the add
export function PastedLayersFields(props: { pasted: PastedLayers; placeholder?: string }) {
	const { pasted } = props
	const validateId = React.useId()
	return (
		<>
			<div className="relative">
				<Textarea
					onChange={(e) => pasted.setText(e.target.value)}
					className="w-full min-h-75 pe-8 min-w overflow-x-auto text-sm font-mono ltr-isolate"
					style={{ lineHeight: '1.5rem' }}
					wrap="off"
					placeholder={props.placeholder ?? tr.text(L_Msgs.multiLayerPlaceholder())}
				/>
			</div>
			<div className="flex items-center gap-1.5">
				<Checkbox id={validateId} checked={pasted.validate} onCheckedChange={pasted.setValidate} />
				<Tooltip help>
					<TooltipTrigger asChild>
						<Label htmlFor={validateId} className="fd-lbl-plain">
							{tr.text(L_Msgs.validateLayers())}
						</Label>
					</TooltipTrigger>
					<TooltipContent>
						<p>{tr.text(L_Msgs.validateLayersHelp())}</p>
					</TooltipContent>
				</Tooltip>
			</div>
			<LayerLineErrors
				errors={pasted.errors.map((line) => ({ lineNumber: line.lineNumber, text: line.text, reason: describeLayerLine(line) }))}
			/>
		</>
	)
}

// lines that cannot be added, each with its number, its text and why
export function LayerLineErrors(props: { errors: { lineNumber: number; text: string; reason: string | null }[] }) {
	if (props.errors.length === 0) return null
	return (
		<Alert variant="destructive">
			<Icons.AlertTriangle />
			<AlertTitle>{tr.text(L_Msgs.pasteErrorsTitle(props.errors.length))}</AlertTitle>
			<AlertDescription>
				<ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
					{props.errors.map((line) => (
						<li key={line.lineNumber} className="flex flex-col text-sm">
							<div className="flex items-baseline gap-2">
								<span className="shrink-0 font-mono text-muted-foreground">{tr.text(L_Msgs.pasteErrorLine(line.lineNumber))}</span>
								<span className="min-w-0 font-mono break-all ltr-isolate">{line.text}</span>
							</div>
							<span className="text-muted-foreground">{line.reason}</span>
						</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	)
}
