import * as Icons from 'lucide-react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { assertNever } from '@/lib/type-guards'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'

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
	const setOpen = props.onOpenChange ?? setInternalOpen

	const [lines, setLines] = React.useState<L.RawLayerLine[]>([])
	const installedMods = props.installedMods

	function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		setLines(L.parseRawLayerLines(e.target.value, { installedMods }))
	}

	const errors = lines.filter((line) => line.code !== 'ok')
	const validLayers = lines.flatMap((line) => (line.code === 'ok' ? [line.layer] : []))

	function handleSubmit() {
		// the text stays put on a rejected paste: the user has to be able to see and fix the offending lines
		if (errors.length > 0 || validLayers.length === 0) return
		props.onSubmit(validLayers)
		setOpen(false)
		setLines([])
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
							placeholder={tr.text(L_Msgs.multiLayerPlaceholder())}
						/>
					</div>
					{errors.length > 0 && (
						<Alert variant="destructive">
							<Icons.AlertTriangle />
							<AlertTitle>{tr.text(L_Msgs.pasteErrorsTitle(errors.length))}</AlertTitle>
							<AlertDescription>
								<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
									{errors.map((line) => (
										<li key={line.lineNumber} className="flex items-baseline gap-2 text-sm">
											<span className="font-mono text-muted-foreground">{tr.text(L_Msgs.pasteErrorLine(line.lineNumber))}</span>
											<span className="font-mono">{line.text}</span>
											<span className="text-muted-foreground">{describe(line)}</span>
										</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					)}
					<div className="flex justify-end space-x-2">
						{props.extraFooter}
						<Button variant="outline" onClick={() => setOpen(false)}>
							{tr.text(UI_Msgs.cancel())}
						</Button>
						<Button onClick={handleSubmit} disabled={validLayers.length === 0 || errors.length > 0}>
							{tr.text(L_Msgs.addLayers(validLayers.length))}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function describe(line: L.RawLayerLine) {
	switch (line.code) {
		case 'err:unparsable':
			return tr.text(L_Msgs.pasteErrorUnparsable())
		case 'err:unknown-layer':
			return tr.text(L_Msgs.pasteErrorUnknownLayer())
		case 'err:mod-not-installed':
			return tr.text(L_Msgs.pasteErrorModNotInstalled(line.collection))
		case 'ok':
			return null
		default:
			assertNever(line)
	}
}
