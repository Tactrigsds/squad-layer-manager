import * as SM from '@/lib/rcon/squad-models'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function ServerUnreachable({ statusRes }: { statusRes: SM.RconError }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>Server is Unreachable</AlertTitle>
			<AlertDescription>{statusRes.msg}</AlertDescription>
		</Alert>
	)
}
