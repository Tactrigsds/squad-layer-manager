// What each page requires, keyed by route id. The app layout evaluates every matched route's entry and shows the
// denial in place of the page, and the nav bar hides a link to a page the user would be refused. Adding a route
// without an entry is a type error.

import { useMatches } from '@tanstack/react-router'

import * as SETTINGS from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import type { FileRoutesById } from '@/routeTree.gen'
import * as RbacClient from '@/systems/rbac.client'

const { Access, Req } = RBAC

type RouteId = keyof FileRoutesById

// the settings page shows whichever of its sections the user can reach, so it is open to anyone who can reach one
const SETTINGS_PAGE = Req.any(
	Req.holdsAnyGrant('admin:manage-servers'),
	Req.holdsAnyGrant('admin:delete-servers'),
	SETTINGS.Grants.globalSettingsRead(),
	Req.holdsAnyGrant('server-settings:read'),
	Req.holdsAnyGrant('server-settings:write'),
	Req.holdsAnyGrant('server-settings:write-sensitive'),
	Req.holdsAnyGrant('plugins:manage'),
)

export const PAGE_ACCESS = {
	__root__: Access.PUBLIC,
	'/': Access.PUBLIC,
	'/_app': Access.PUBLIC,
	'/_app/about': Access.PUBLIC,
	'/_app/commands': Access.PUBLIC,
	'/_app/history': Access.req(Req.perm('history:query')),
	'/_app/settings': Access.req(SETTINGS_PAGE),
	'/_app/tutorials': Access.PUBLIC,
	'/_sandbox/sandbox': Access.PUBLIC,
	'/_app/filters/$filterId': Access.PUBLIC,
	'/_app/filters/new': Access.req(Req.perm('filters:create')),
	'/_app/servers/$serverId': Access.req((params: { serverId: string }) => Req.viewServer(params.serverId)),
	'/layers/$layerId/$tab': Access.PUBLIC,
	'/_app/filters/': Access.PUBLIC,
	'/_app/servers/': Access.PUBLIC,
} satisfies { [K in RouteId]: RBAC.Access<any> }

type Entries = typeof PAGE_ACCESS
export type ParamlessPage = { [K in RouteId]: Entries[K] extends { req: (...args: any[]) => any } ? never : K }[RouteId]

// the denial for the page currently shown, from every matched route's entry
export function useCurrentPageDenial(): RBAC.PermissionDeniedResponse | null {
	const matches = useMatches()
	const reqs = matches.flatMap((match) => {
		const req = Access.resolve(PAGE_ACCESS[match.routeId as RouteId] as RBAC.Access<unknown>, match.params)
		return req ? [req] : []
	})
	return RbacClient.usePermsCheck(Req.all(...reqs))
}

// what a page without params requires; an empty "all" for a public one
export function pageReq(routeId: ParamlessPage): RBAC.Req {
	return Access.resolve(PAGE_ACCESS[routeId] as RBAC.Access<void>, undefined) ?? Req.all()
}

// the denial a page without params would give, for deciding whether to link to it
export function usePageDenial(routeId: ParamlessPage): RBAC.PermissionDeniedResponse | null {
	return RbacClient.usePermsCheck(pageReq(routeId))
}
