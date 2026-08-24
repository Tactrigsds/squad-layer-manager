import * as React from 'react'

import * as Zus from '@/lib/zustand'
import * as PluginsClient from '@/systems/plugins.client'

// Renders whatever plugins registered at an anchor. Each registration is boundary-wrapped so one
// plugin's render error cannot take the page down with it.
export function PluginSlot<A extends PluginsClient.SlotAnchorId>(props: { anchor: A; anchorProps: PluginsClient.SlotAnchors[A] }) {
	// subscription only: a version bump re-renders this so getSlotRegs re-reads the live map. Kept
	// out of the key, or every slot would remount whenever any plugin (un)registers anything.
	Zus.useStore(PluginsClient.Store, (s) => s.version)
	const regs = PluginsClient.getSlotRegs(props.anchor)
	if (regs.length === 0) return null
	return (
		<>
			{regs.map((reg) => (
				<PluginErrorBoundary key={reg.regKey} pluginId={reg.pluginId}>
					<reg.component {...props.anchorProps} />
				</PluginErrorBoundary>
			))}
		</>
	)
}

class PluginErrorBoundary extends React.Component<{ pluginId: string; children: React.ReactNode }, { failed: boolean }> {
	state = { failed: false }
	static getDerivedStateFromError() {
		return { failed: true }
	}
	componentDidCatch(error: unknown) {
		console.error(`plugin ${this.props.pluginId}: slot render failed`, error)
	}
	render() {
		return this.state.failed ? null : this.props.children
	}
}
