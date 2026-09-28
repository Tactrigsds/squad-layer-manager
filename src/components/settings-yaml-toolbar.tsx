import * as Icons from 'lucide-react'
import type React from 'react'

import type { SchemaYamlEditorHandle } from '@/components/schema-yaml-editor.types'
import { Button } from '@/components/ui/button'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { tr } from '@/systems/messages.client'

// Format/Reset/Save for a YAML-mode section. Lives in the editor's own header row (SchemaYamlEditor's `toolbar` slot)
// rather than below it, so it stays reachable once the editor goes fullscreen and covers the page.
export function YamlEditorToolbar({
	editorRef,
	deniedPaths,
	canSave,
	saving,
	onSave,
}: {
	editorRef: React.RefObject<SchemaYamlEditorHandle | null>
	deniedPaths: string[]
	canSave: boolean
	saving: boolean
	onSave: () => void
}) {
	return (
		<>
			{deniedPaths.length > 0 && (
				<p className="min-w-0 truncate text-xs text-warn">
					{tr.text(SETTINGS_Msgs.notPermittedToModify())}{' '}
					{deniedPaths.map((p) => (
						<code key={p} className="mx-0.5">
							{p}
						</code>
					))}
				</p>
			)}
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.format()}>
				<Icons.Braces className="h-4 w-4" />
				{tr.text(SETTINGS_Msgs.format())}
			</Button>
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.reset()}>
				{tr.text(SETTINGS_Msgs.reset())}
			</Button>
			<Button size="sm" disabled={!canSave || saving} onClick={onSave}>
				{saving ? tr.text(SETTINGS_Msgs.saving()) : tr.text(SETTINGS_Msgs.save())}
			</Button>
		</>
	)
}
