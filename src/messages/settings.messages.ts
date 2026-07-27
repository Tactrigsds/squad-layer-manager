import * as Msgs from '@/messages/shared'

export const saved = Msgs.def(() => ({ toast: () => ['Settings saved'] }))

export const serverSettingsSaved = Msgs.def(() => ({ toast: () => ['Server settings saved'] }))

export const serverCreated = Msgs.def(() => ({ toast: () => ['Server created'] }))

// reason is the server's own account of which field failed
export const invalid = Msgs.def((reason: string) => ({
	toast: () => ['Invalid settings', { description: reason }],
}))

export const saveFailed = Msgs.def((reason: string) => ({
	toast: () => ['Error while saving settings:', { description: reason }],
}))

export const serverNotFound = Msgs.def(() => ({ toast: () => ['Server not found'] }))

export const serverIdTaken = Msgs.def(() => ({ toast: () => ['A server with that ID already exists'] }))

// displayName is absent for the global settings, which belong to no server
export const confirmSave = Msgs.def((displayName?: string) => ({
	confirm: () => ({
		title: displayName === undefined ? 'Save global settings?' : `Save ${displayName} settings?`,
		confirmLabel: 'Save',
	}),
}))

export const confirmDeleteServer = Msgs.def((displayName: string, serverId: string) => ({
	confirm: () => ({
		title: 'Delete Managed Server',
		description: `Delete managed server "${displayName}" (${serverId})? This cannot be undone.`,
		confirmLabel: 'Delete',
	}),
}))

// the browser's own confirm(), which takes a bare string
export const unsavedChanges = Msgs.def(() => ({
	text: () => 'You have unsaved settings changes. Are you sure you want to leave?',
}))
