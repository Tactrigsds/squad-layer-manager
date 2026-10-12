// Lazily loaded: RFMT pulls in the whole `yaml` package.
import * as Icons from 'lucide-react'
import React from 'react'

import { PlacementButtons } from '@/components/add-rotation-dialog'
import { LayerTextImportFields } from '@/components/layer-text-import'
import { useLayerTextImport } from '@/components/layer-text-import.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import TabsList from '@/components/ui/tabs-list'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as LL from '@/models/layer-list.models'
import * as RFMT from '@/models/rotation-format.models'
import type * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

type Mode = 'export' | 'import'

export default function RotationExchangeDialog(props: {
	mode: Mode
	rotationId: ROT.RotationId
	queue: LayerQueuePrt.KeyProp['queue']
	onClose: () => void
}) {
	return (
		<Dialog open onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent className="max-w-2xl min-w-[min(760px,90vw)]">
				<DialogHeader>
					<DialogTitle>{tr.text(props.mode === 'export' ? ROT_Msgs.exportTitle() : ROT_Msgs.importTitle())}</DialogTitle>
				</DialogHeader>
				{props.mode === 'export' ? (
					<ExportPanel rotationId={props.rotationId} queue={props.queue} />
				) : (
					<ImportPanel queue={props.queue} onDone={props.onClose} />
				)}
			</DialogContent>
		</Dialog>
	)
}

function ExportPanel(props: { rotationId: ROT.RotationId; queue: LayerQueuePrt.KeyProp['queue'] }) {
	const [format, setFormat] = React.useState<RFMT.Format>('yaml')
	const [notes, setNotes] = React.useState(true)
	const [tags, setTags] = React.useState(true)
	const list = Zus.useStore(props.queue, LayerQueuePrt.Sel.layerList)
	const configuredTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
	const text = format === 'yaml' ? RFMT.toYaml(list, { notes, tags, configuredTags }) : RFMT.toPlainText(list, { notes })
	const droppedTags = format === 'text' ? RFMT.plainTextDroppedTags(list) : 0
	const notesId = React.useId()
	const tagsId = React.useId()

	const copy = async () => {
		await navigator.clipboard.writeText(text)
		toast(tr.text(ROT_Msgs.copied()))
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<TabsList
					variant="seg"
					options={[
						{ label: tr.text(ROT_Msgs.formatYaml()), value: 'yaml' },
						{ label: tr.text(ROT_Msgs.formatText()), value: 'text' },
					]}
					active={format}
					setActive={setFormat}
				/>
				<div className="flex items-center gap-1.5">
					<Checkbox id={notesId} checked={notes} onCheckedChange={setNotes} />
					<Label htmlFor={notesId} className="fd-lbl-plain">
						{tr.text(ROT_Msgs.includeNotes())}
					</Label>
				</div>
				<div className="flex items-center gap-1.5">
					<Checkbox id={tagsId} checked={tags && format === 'yaml'} disabled={format !== 'yaml'} onCheckedChange={setTags} />
					<Label htmlFor={tagsId} className="fd-lbl-plain">
						{tr.text(ROT_Msgs.includeTags())}
					</Label>
				</div>
				<span className="flex-1" />
				<Button
					variant="outline"
					size="sm"
					disabled={!text}
					onClick={() => download(text, `${props.rotationId}.${format === 'yaml' ? 'yaml' : 'txt'}`)}
				>
					<Icons.Download />
					{tr.text(ROT_Msgs.download())}
				</Button>
				<Button variant="outline" size="sm" disabled={!text} onClick={() => void copy()}>
					<Icons.Copy />
					{tr.text(ROT_Msgs.copy())}
				</Button>
			</div>
			{text ? (
				<pre
					aria-label={tr.text(ROT_Msgs.exportButton())}
					className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5 ltr-isolate"
				>
					{text}
				</pre>
			) : (
				<p className="text-sm text-muted-foreground">{tr.text(ROT_Msgs.nothingToExport())}</p>
			)}
			{droppedTags > 0 && <p className="text-xs text-muted-foreground">{tr.text(ROT_Msgs.plainTextDropsTags(droppedTags))}</p>}
		</div>
	)
}

function ImportPanel(props: { queue: LayerQueuePrt.KeyProp['queue']; onDone: () => void }) {
	const importer = useLayerTextImport({})
	const [placement, setPlacement] = React.useState<LL.Placement>('end')
	const [importing, setImporting] = React.useState(false)
	const textareaRef = React.useRef<HTMLTextAreaElement>(null)
	const fileRef = React.useRef<HTMLInputElement>(null)

	const loadFile = async (file: File) => {
		const text = await file.text()
		if (textareaRef.current) textareaRef.current.value = text
		importer.setText(text)
	}

	const submit = async () => {
		if (!importer.ready || importing) return
		setImporting(true)
		try {
			const items = await importer.buildItems()
			if (!items) return
			const ok = await LayerQueuePrt.Actions.addRotation(
				{ queue: props.queue },
				{ rotation: { type: 'items', items }, placement, tags: [] },
			)
			if (ok) props.onDone()
		} finally {
			setImporting(false)
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<p className="flex-1 text-sm text-muted-foreground">{tr.text(ROT_Msgs.importPlaceholder())}</p>
				<input
					ref={fileRef}
					type="file"
					accept=".yaml,.yml,.txt,text/plain"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0]
						if (file) void loadFile(file)
					}}
				/>
				<Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
					<Icons.FolderOpen />
					{tr.text(ROT_Msgs.openFile())}
				</Button>
			</div>
			<LayerTextImportFields importer={importer} label={tr.text(ROT_Msgs.importButton())} textareaRef={textareaRef} />
			<div className="flex flex-wrap items-center justify-end gap-2">
				<PlacementButtons placement={placement} onChange={setPlacement} />
				<span className="flex-1" />
				<Button variant="outline" onClick={props.onDone}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
				<Button variant="primary" disabled={!importer.ready || importing} onClick={() => void submit()}>
					{tr.text(ROT_Msgs.importItems(importer.itemCount))}
				</Button>
			</div>
		</div>
	)
}

function download(text: string, filename: string) {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	a.click()
	URL.revokeObjectURL(url)
}
