import * as SS_Msgs from '@/messages/server-state.messages'
import type * as SM from '@/models/squad.models'

import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function ServerUnreachable({ statusRes }: { statusRes: SM.RconError }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{SS_Msgs.rconUnreachable().text()}</AlertTitle>
			<AlertDescription>{statusRes.msg}</AlertDescription>
		</Alert>
	)
}
