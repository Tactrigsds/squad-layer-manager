import * as SM from '@/models/squad.models'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function ServerUnreachable({ statusRes }: { statusRes: SM.RconError }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>Unable To connect to RCON server</AlertTitle>
			<AlertDescription>{statusRes.msg}</AlertDescription>
		</Alert>
	)
}
