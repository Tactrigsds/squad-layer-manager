import * as Icons from 'lucide-react'
import React from 'react'

import type { LayerTextImport, TagChoice } from '@/components/layer-text-import.helpers'
import { LayerLineErrors } from '@/components/multi-layer-set-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as L_Msgs from '@/messages/layer.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import { tr } from '@/systems/messages.client'

// the Select's value for a choice: the choice's type, or the tag id it maps onto
function choiceValue(choice: TagChoice): string {
	return choice.type === 'map' ? choice.tagId : choice.type
}

function choiceFromValue(value: string): TagChoice {
	if (value === 'create' || value === 'drop') return { type: value }
	return { type: 'map', tagId: value }
}

// The textarea for layers given as text, and what reading it found: the format, the tags it names, and the lines it
// cannot use
export function LayerTextImportFields(props: {
	importer: LayerTextImport
	label: string
	placeholder?: string
	// offers turning layer validation off, which lets layers the database does not know through
	validateToggle?: boolean
	textareaRef?: React.Ref<HTMLTextAreaElement>
}) {
	const { importer } = props
	const onText = useDebounced({ delay: 200, onChange: importer.setText })
	const validateId = React.useId()
	return (
		<>
			<Textarea
				ref={props.textareaRef}
				aria-label={props.label}
				placeholder={props.placeholder}
				onChange={(e) => onText(e.target.value)}
				className="min-h-60 w-full overflow-x-auto font-mono text-xs leading-5 ltr-isolate"
				wrap="off"
			/>
			{props.validateToggle && (
				<div className="flex items-center gap-1.5">
					<Checkbox id={validateId} checked={importer.validate} onCheckedChange={importer.setValidate} />
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
			)}
			{importer.parsed && (
				<p role="status" className="text-sm">
					{tr.text(
						ROT_Msgs.importSummary(
							tr.text(importer.format === 'yaml' ? ROT_Msgs.formatYaml() : ROT_Msgs.formatText()),
							importer.itemCount,
							importer.noteCount,
						),
					)}
				</p>
			)}
			{importer.tagLabels.length > 0 && (
				<ul className="flex flex-col gap-1.5 text-sm">
					{importer.tagLabels.map(({ label, match }) =>
						match ? (
							<li key={label} className="flex items-center gap-2 text-muted-foreground">
								<Icons.Check className="h-4 w-4 text-added" aria-hidden />
								{tr.text(ROT_Msgs.tagMatches(label))}
							</li>
						) : (
							<li key={label} className="flex flex-wrap items-center gap-2">
								<Icons.CircleAlert className="h-4 w-4 text-warning" aria-hidden />
								<span className="min-w-0">{tr.text(ROT_Msgs.tagUnknown(label))}</span>
								<Select
									value={choiceValue(importer.choiceFor(label))}
									onValueChange={(value) => importer.setChoice(label, choiceFromValue(value))}
								>
									<SelectTrigger aria-label={tr.text(ROT_Msgs.tagChoiceLabel(label))} className="h-7 w-auto min-w-40">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{importer.canCreateTags && <SelectItem value="create">{tr.text(ROT_Msgs.tagCreate())}</SelectItem>}
										<SelectItem value="drop">{tr.text(ROT_Msgs.tagDrop())}</SelectItem>
										{importer.configuredTags.map((tag) => (
											<SelectItem key={tag.id} value={tag.id}>
												{tr.text(ROT_Msgs.tagMapTo(tag.label))}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</li>
						),
					)}
				</ul>
			)}
			<LayerLineErrors errors={importer.errors} />
		</>
	)
}
