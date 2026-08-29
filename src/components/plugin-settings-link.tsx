import * as TSR from '@tanstack/react-router'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'

/**
 * A link from a plugin's own UI to where it is configured: `slm/components/plugin-settings-link`.
 *
 * `path` is a dotted path into the plugin's config schema, which lands on that field rather than on the
 * plugin's section header. Renders nothing for a user who cannot open the settings page at all, so a plugin
 * does not have to run the permission check itself.
 */
export function PluginSettingsLink({
	pluginId,
	path,
	className,
	children,
}: {
	pluginId: string
	path?: string
	className?: string
	children?: React.ReactNode
}) {
	const managePluginsDenied = RbacClient.usePermsCheck(RBAC.perm('plugins:manage'))
	const globalAccess = RbacClient.useGlobalSettingsAccess()
	if (!globalAccess.canRead && managePluginsDenied) return null
	return (
		<TSR.Link
			to="/settings"
			hash={path ? `setting:plugin:${pluginId}:${path}` : `section:plugin:${pluginId}`}
			className={cn('underline-offset-2 hover:underline', className)}
		>
			{children}
		</TSR.Link>
	)
}
