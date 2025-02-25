export function formatVersion(branch?: string, sha?: string): string {
	return `${branch ?? 'unknown'};${sha ?? 'unknown'}`
}
