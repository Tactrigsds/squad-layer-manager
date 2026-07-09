// shared labeling for the settings GUI form + its table-of-contents, so overrides stay consistent across both.

// display-name overrides keyed by dotted settings path; falls back to humanize() otherwise
const LABEL_OVERRIDES: Record<string, string> = {
	rbac: 'Permissions & Roles',
	'rbac.roleAssignments.discord-role': 'By Discord Role',
	'rbac.roleAssignments.discord-user': 'Specific User',
	'rbac.roleAssignments.discord-server-member': 'All Server Members',
	// per-server settings
	connections: 'Connections',
	'connections.rcon': 'RCON',
	'connections.logs': 'Log Source',
}

export function humanize(key: string): string {
	const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function settingLabel(path: (string | number)[], key: string): string {
	return LABEL_OVERRIDES[path.join('.')] ?? humanize(key)
}
