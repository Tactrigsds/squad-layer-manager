import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as L from '@/models/layer'

export type MultiLayerSetDialogProps = {
	onSubmit: (layers: L.UnvalidatedLayer[]) => void
	open?: boolean
	onOpenChange?: (open: boolean) => void
	trigger?: React.ReactNode
	title?: string
	extraFooter?: React.ReactNode
}

export function MultiLayerSetDialog(props: MultiLayerSetDialogProps) {
	const [internalOpen, setInternalOpen] = React.useState(false)
	const open = props.open ?? internalOpen
	const setOpen = props.onOpenChange ?? setInternalOpen

	const [possibleLayers, setPossibleLayers] = React.useState<L.UnvalidatedLayer[]>([])

	function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const text = e.target.value
		const lines = text
			.trim()
			.split('\n')
			.filter((line) => line.trim().length > 0)
		const layers = lines.map((line) => L.parseRawLayerText(line.trim())).filter((l) => l !== null)
		setPossibleLayers(layers)
	}

	function handleSubmit() {
		props.onSubmit(possibleLayers)
		setOpen(false)
		setPossibleLayers([])
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{props.trigger && <DialogTrigger asChild>{props.trigger}</DialogTrigger>}
			<DialogContent className="max-w-lg min-w-[min(700px,70vw)]">
				<DialogHeader>
					<DialogTitle>{props.title ?? 'Add Multiple Layers'}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<div className="relative">
						<Textarea
							onChange={onTextChange}
							className="w-full min-h-75 pr-8 min-w overflow-x-auto text-sm font-mono"
							style={{ lineHeight: '1.5rem' }}
							wrap="off"
							placeholder={L_Msgs.multiLayerPlaceholder().text()}
						/>
					</div>
					<div className="flex justify-end space-x-2">
						{props.extraFooter}
						<Button variant="outline" onClick={() => setOpen(false)}>
							{UI_Msgs.cancel().text()}
						</Button>
						<Button onClick={handleSubmit} disabled={possibleLayers.length === 0}>
							{L_Msgs.addLayers(possibleLayers.length).text()}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
