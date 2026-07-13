import * as ATTRS from '@/models/otel-attrs'
import * as SquadServer from '@/systems/squad-server.server'
import * as Otel from '@opentelemetry/api'

// Domain gauges. Everything here is read synchronously out of in-memory slice state on the metric
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
	meter.createObservableGauge(ATTRS.SquadServer.COUNT, {
		description: 'Number of squad server slices currently initialized',
	}).addCallback((result) => {
		result.observe(SquadServer.globalState.slices.size)
	})

	meter.createObservableGauge(ATTRS.Rcon.CONNECTED, {
		description: 'Whether the rcon connection for this squad server is up (1) or down (0)',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			result.observe(slice.rcon.connected ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
		}
	})

	meter.createObservableGauge(ATTRS.LayerQueue.LENGTH, {
		description: 'Number of items in the live (unsaved) layer queue',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			result.observe(slice.layerQueue.session.state.list.length, { [ATTRS.SquadServer.ID]: serverId })
		}
	})

	meter.createObservableGauge(ATTRS.LayerQueue.UNSAVED, {
		description: 'Whether the layer queue has edits not yet written back (1) or is in sync (0)',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			const state = slice.layerQueue.session.state
			result.observe(state.list.length !== state.savedList.length ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
		}
	})

	meter.createObservableGauge(ATTRS.Vote.IN_PROGRESS, {
		description: 'Whether a layer vote is currently running on this squad server',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			result.observe(slice.vote.state?.code === 'in-progress' ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
		}
	})

	meter.createObservableGauge(ATTRS.Teamswap.PENDING_SWAPS, {
		description: 'Number of team swaps saved and waiting to be executed',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			result.observe(slice.teamswaps.session.state.pendingSwaps.size, { [ATTRS.SquadServer.ID]: serverId })
		}
	})

	meter.createObservableGauge(ATTRS.Teamswap.SWAPPING, {
		description: 'Whether a team swap execution is currently in flight',
	}).addCallback((result) => {
		for (const [serverId, slice] of SquadServer.globalState.slices) {
			result.observe(slice.teamswaps.session.state.swapping ? 1 : 0, { [ATTRS.SquadServer.ID]: serverId })
		}
	})
}
