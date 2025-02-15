import { Alert, AlertTitle, AlertDescription } from './ui/alert'
import * as SM from '@/lib/rcon/squad-models'

export function ServerUnreachable({ statusRes }: { statusRes: SM.RconError }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>Server is Unreachable</AlertTitle>
			<AlertDescription>{statusRes.msg}</AlertDescription>
		</Alert>
	)
}
