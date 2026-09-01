import * as Zus from '@/lib/zustand'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import type * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'

import { AppEventActor } from './feed/app-event-rows'
import * as Atoms from './feed/atoms'
import { Icon } from './feed/icons'
import type * as RC from './feed/render-context'
import { PluginErrorBoundary } from './plugin-slot.tsx'

// The one feed row that has to stay react: a plugin's own event, where the plugin registered a renderer for it
// (see registerEventRenderer). Its content is arbitrary react built in the browser, so it can neither be
// serialized on the server nor walked to dom like the inert templates. Every other app event is a template
// (app-event-rows.tsx), and a plugin event with no registered renderer draws the generic line there.
//
// The plugin's name stays the prefix, as on every other feed line; the registered renderer supplies the
// predicate only.

// The icons a plugin may pick from. Fixed markup per name so a plugin line looks like every other feed line,
// and so no plugin has to ship an icon set.
const PLUGIN_EVENT_ICONS: Record<PluginsClient.EventIcon, React.ReactNode> = {
	plugin: <Icon name="Puzzle" className="h-4 w-4 text-slate-400 shrink-0" />,
	info: <Icon name="Info" className="h-4 w-4 text-blue-400 shrink-0" />,
	success: <Icon name="CheckCircle2" className="h-4 w-4 text-green-500 shrink-0" />,
	warning: <Icon name="AlertTriangle" className="h-4 w-4 text-amber-500 shrink-0" />,
	error: <Icon name="XCircle" className="h-4 w-4 text-red-500 shrink-0" />,
}

export function PluginEventRow(props: { ctx: RC.RenderCtx; event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }> }) {
	const { ctx, event } = props
	const appEvent = event.appEvent as AppEvents.PluginEvent
	// subscription only: a version bump re-renders this so the renderer map is re-read live
	Zus.useStore(PluginsClient.Store, (s) => s.version)
	const rendering = PluginsClient.getEventRendering(appEvent.pluginId, {
		name: appEvent.name,
		payload: appEvent.payload,
		message: appEvent.message,
		time: appEvent.time,
		serverId: appEvent.serverId,
		matchId: appEvent.matchId,
	})
	const actorLabel = <AppEventActor ctx={ctx} event={event} />
	return (
		<Atoms.EventLine time={event.time} icon={PLUGIN_EVENT_ICONS[rendering?.icon ?? 'plugin']}>
			{rendering
				? tr.richText(
						AppEvents_Msgs.pluginLine(
							actorLabel,
							<PluginErrorBoundary pluginId={appEvent.pluginId}>{rendering.content}</PluginErrorBoundary>,
						),
					)
				: tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
		</Atoms.EventLine>
	)
}
