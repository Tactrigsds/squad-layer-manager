import * as ZusUtils from '@/lib/zustand'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as Zus from 'zustand'

export default function TeamsPanel() {
	const [players, squads] = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useShallow(s => [s.chatState.interpolatedState.players, s.chatState.interpolatedState.squads]),
	)
	return <div>teams panel</div>
}
