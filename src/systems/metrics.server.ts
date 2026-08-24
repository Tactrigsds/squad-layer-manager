import * as Otel from '@opentelemetry/api'

import * as ATTRS from '@/models/otel-attrs'
import * as Plugins from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

// Domain gauges. Everything here is read synchronously out of in-memory managed server state on the metric
// reader's export interval, so nothing in a callback may do I/O: an rcon or db round trip here would
// stall the export and generate load proportional to the scrape rate. The rcon/queue/vote state we
// want is all already resident (BehaviorSubjects and ODSM sessions), so it never needs to.
//
// Per-server gauges are all keyed by slm.squad_server.id, which is bounded by the number of configured
// servers.
const meter = Otel.metrics.getMeter('squad-layer-manager')

// setup rather than module scope so the gauges register against the real meter provider (the global
// one is a no-op until NodeSDK.start()) and after squad-server has its globalState.
export function setup() {
	// A plugin's own telemetry is separated from the host's by its `plugin:<id>` module name, and its ops
	// carry slm.plugin.id on slm.op.duration. These two carry the rest of its identity: join a plugin's
	// series against INFO on slm.plugin.id rather than stamping version and source onto each of them.
	meter
		.createObservableGauge(ATTRS.Plugin.INFO, {
			description: 'Constant 1 per installed plugin, carrying its version, source and declared api range',
		})
		.addCallback((result) => {
			for (const info of Plugins.listRuntimeInfo()) {
				result.observe(1, {
					[ATTRS.Plugin.ID]: info.id,
					[ATTRS.Plugin.VERSION]: info.version,
					[ATTRS.Plugin.SOURCE]: info.source,
					[ATTRS.Plugin.API_VERSION]: info.apiVersion,
				})
			}
		})

	meter
		.createObservableGauge(ATTRS.Plugin.STATUS, {
			description: 'Constant 1 on the status each plugin is currently in',
		})
		.addCallback((result) => {
			for (const info of Plugins.listRuntimeInfo()) {
				result.observe(1, { [ATTRS.Plugin.ID]: info.id, [ATTRS.Plugin.STATUS]: info.status })
			}
		})

	meter
		.createObservableGauge(ATTRS.SquadServer.COUNT, {
			description: 'Number of managed servers currently initialized',
		})
		.addCallback((result) => {
			result.observe(SquadServer.globalState.managedServers.size)
		})

	meter
		.createObservableGauge(ATTRS.Rcon.CONNECTED, {
			description: 'Whether the rcon connection for this squad server is up (1) or down (0)',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.rcon.connected ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.LayerQueue.LENGTH, {
			description: 'Number of items in the live (unsaved) layer queue',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.layerQueue.session.state.list.length, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.LayerQueue.UNSAVED, {
			description: 'Whether the layer queue has edits not yet written back (1) or is in sync (0)',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				const state = managedServer.layerQueue.session.state
				result.observe(state.list.length !== state.savedList.length ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.SquadLogs.MIN_SAFE_LEAD, {
			description: 'Hold-back applied to non-log events to keep ordering safe against log delivery lag; retuned from measured lag',
			unit: 'ms',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				const ms = managedServer.server.eventState.minSafeLeadTimeForOtherEventsSinceLog
				if (Number.isFinite(ms)) result.observe(ms, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.Vote.IN_PROGRESS, {
			description: 'Whether a layer vote is currently running on this squad server',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.vote.state?.code === 'in-progress' ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.Teamswap.PENDING_SWAPS, {
			description: 'Number of team swaps saved and waiting to be executed',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.teamswaps.session.state.pendingSwaps.size, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	meter
		.createObservableGauge(ATTRS.Teamswap.SWAPPING, {
			description: 'Whether a team swap execution is currently in flight',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.teamswaps.session.state.swapping ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
			}
		})

	// split by the team players are asking to leave: a queue that is deep on one side only is an imbalance
	// nobody can drain, where the same depth on both sides pairs off into mutual swaps immediately
	meter
		.createObservableGauge(ATTRS.SwitchRequest.QUEUED, {
			description: 'Players queued for a team switch, by the team they are asking to leave',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				const requests = managedServer.switchRequests.state.requests
				for (const fromTeam of [1, 2] as const) {
					result.observe(requests.filter((r) => r.fromTeam === fromTeam).length, {
						[ATTRS.SquadServer.ID]: serverId,
						[ATTRS.SwitchRequest.FROM_TEAM]: fromTeam,
					})
				}
			}
		})

	meter
		.createObservableGauge(ATTRS.SwitchRequest.SWITCHING, {
			description: 'Switch requests whose forced team change is in flight',
		})
		.addCallback((result) => {
			for (const [serverId, managedServer] of SquadServer.globalState.managedServers) {
				result.observe(managedServer.switchRequests.swapping.size, { [ATTRS.SquadServer.ID]: serverId })
			}
		})
}
