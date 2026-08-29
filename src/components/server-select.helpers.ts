import type { ComboBoxOption } from '@/components/combo-box/combo-box.tsx'

// unknown ids (a server that has since been deleted) stay selectable, so opening an editor can never
// silently drop a stored value
export function serverOptionsFor(servers: { id: string; displayName: string }[], selected: string[]): ComboBoxOption<string>[] {
	const known: ComboBoxOption<string>[] = servers.map((s) => ({
		value: s.id,
		label: `${s.displayName} (${s.id})`,
		keywords: [s.displayName],
	}))
	const unknown = selected.filter((id) => !servers.some((s) => s.id === id)).map((id) => ({ value: id }))
	return [...unknown, ...known]
}
