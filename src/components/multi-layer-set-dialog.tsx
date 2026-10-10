import * as Icons from 'lucide-react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assertNever } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import * as L_Msgs from '@/messages/layer.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as L from '@/models/layer.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
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
	const setOpenProp = props.onOpenChange ?? setInternalOpen
	const validateId = React.useId()

	const [lines, setLines] = React.useState<L.RawLayerLine[]>([])
	const [validate, setValidate] = React.useState(true)
	const installedMods = props.installedMods

	function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		setLines(L.parseRawLayerLines(e.target.value, { installedMods }))
	}

	// the textarea unmounts with the dialog, so the lines parsed from it go too
	function setOpen(open: boolean) {
		if (!open) setLines([])
		setOpenProp(open)
	}

	const knownIds = validate ? lines.flatMap((line) => (line.code === 'ok' ? [line.layer.id] : [])) : []
	const existsRes = LayerQueriesClient.useLayerExists(knownIds, { enabled: knownIds.length > 0, usePlaceholderData: true })
	const { errors, layers, pending } = resolveLines(lines, validate, existsRes.data)

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
					<div className="relative">
						<Textarea
							onChange={onTextChange}
							className="w-full min-h-75 pe-8 min-w overflow-x-auto text-sm font-mono ltr-isolate"
							style={{ lineHeight: '1.5rem' }}
							wrap="off"
							placeholder={tr.text(L_Msgs.multiLayerPlaceholder())}
						/>
					</div>
					<div className="flex items-center gap-1.5">
						<Checkbox id={validateId} checked={validate} onCheckedChange={setValidate} />
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
					{errors.length > 0 && (
						<Alert variant="destructive">
							<Icons.AlertTriangle />
							<AlertTitle>{tr.text(L_Msgs.pasteErrorsTitle(errors.length))}</AlertTitle>
							<AlertDescription>
								<ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
									{errors.map((line) => (
										<li key={line.lineNumber} className="flex flex-col text-sm">
											<div className="flex items-baseline gap-2">
												<span className="shrink-0 font-mono text-muted-foreground">
													{tr.text(L_Msgs.pasteErrorLine(line.lineNumber))}
												</span>
												<span className="min-w-0 font-mono break-all ltr-isolate">{line.text}</span>
											</div>
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
						<Button variant="primary" onClick={handleSubmit} disabled={layers.length === 0 || errors.length > 0 || pending}>
							{tr.text(L_Msgs.addLayers(layers.length))}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

// Splits parsed lines into what is added and what blocks the add. With validation on, a line that parsed to a known
// layer is also checked against the layer database, the authority on what can be queued, and is pending until that
// check answers. With validation off, only a missing mod blocks, since the server refuses it.
function resolveLines(lines: L.RawLayerLine[], validate: boolean, existence: { id: L.LayerId; exists: boolean }[] | undefined) {
	const exists = new Map(existence?.map((res) => [res.id, res.exists]))
	const errors: L.RawLayerLine[] = []
	const layers: L.UnvalidatedLayer[] = []
	let pending = false
	for (const line of lines) {
		switch (line.code) {
			case 'ok': {
				if (!validate) {
					layers.push(line.layer)
					break
				}
				const found = exists.get(line.layer.id)
				if (found === undefined) pending = true
				else if (found) layers.push(line.layer)
				else errors.push({ ...line, code: 'err:unknown-layer', problems: [] })
				break
			}
			case 'err:unparsable':
			case 'err:unknown-layer':
				if (validate) errors.push(line)
				else if (line.layer) layers.push(line.layer)
				break
			case 'err:mod-not-installed':
				errors.push(line)
				break
			default:
				assertNever(line)
		}
	}
	return { errors, layers, pending }
}

function describe(line: L.RawLayerLine) {
	switch (line.code) {
		case 'err:unparsable':
		case 'err:unknown-layer':
			if (line.problems.length === 0) return tr.text(L_Msgs.pasteErrorUnknownLayer())
			return MsgFmt.formatList(line.problems.map(describeProblem), { type: 'unit' })
		case 'err:mod-not-installed':
			return tr.text(L_Msgs.pasteErrorModNotInstalled(line.collection))
		case 'ok':
			return null
		default:
			assertNever(line)
	}
}

function describeProblem(problem: L.RawLayerProblem) {
	switch (problem.code) {
		case 'unknown-layer':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownLayer(problem.value)), problem.suggestion)
		case 'unknown-faction':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownFaction(problem.value, problem.team)), problem.suggestion)
		case 'unknown-unit':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownUnit(problem.value, problem.team)), problem.suggestion)
		case 'missing-faction':
			return tr.text(L_Msgs.pasteProblemMissingFaction(problem.team))
		case 'unavailable-faction': {
			const faction = problem.unit ? `${problem.faction}+${problem.unit}` : problem.faction
			return tr.text(L_Msgs.pasteProblemUnavailableFaction(faction, problem.team))
		}
		case 'mirror-matchup':
			return tr.text(L_Msgs.pasteProblemMirrorMatchup(problem.faction))
		default:
			assertNever(problem)
	}
}

function withSuggestion(text: string, suggestion: string | null) {
	return suggestion ? `${text} ${tr.text(L_Msgs.pasteProblemDidYouMean(suggestion))}` : text
}
