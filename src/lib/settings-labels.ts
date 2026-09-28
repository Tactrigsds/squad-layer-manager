export function humanize(key: string): string {
	const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
