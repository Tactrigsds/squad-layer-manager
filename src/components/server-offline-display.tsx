import * as SS_Msgs from '@/messages/server-state.messages'
import type * as SM from '@/models/squad.models'
import { tr } from '@/systems/messages.client'

import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function ServerUnreachable({ statusRes }: { statusRes: SM.RconError }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{tr.text(SS_Msgs.rconUnreachable())}</AlertTitle>
			<AlertDescription>{statusRes.msg}</AlertDescription>
		</Alert>
	)
}
