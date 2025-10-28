import { cn } from '@/lib/utils'
import * as Messages from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import * as MH from '@/models/match-history.models'
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export default function BalanceTriggerAlert(
	props: { event: BAL.BalanceTriggerEvent; referenceMatch: MH.MatchDetails; className?: string },
) {
	if (!BAL.isKnownEventInstance(props.event)) return null
	const trigger = BAL.TRIGGERS[props.event.triggerId]
	if (!trigger) return null
	let AlertIcon
	let variant: 'default' | 'destructive' | 'info' | 'warning'
	switch (props.event.level) {
		case 'violation':
			AlertIcon = AlertOctagon
			variant = 'destructive'
			break
		case 'warn':
			AlertIcon = AlertTriangle
			variant = 'warning'
			break
		case 'info':
			AlertIcon = Info
			variant = 'info'
			break
		default:
			AlertIcon = Info
			variant = 'default'
	}
	return (
		<Alert variant={variant} key={props.event.id} className={cn('w-full !bg-background', props.className)}>
			<AlertTitle className="flex items-center space-x-2">
				<AlertIcon className="h-4 w-4 mr-2" />
				{trigger.name}
			</AlertTitle>
			<AlertDescription>
				{Messages.GENERAL.balanceTrigger.showEvent(props.event, props.referenceMatch, false)}
			</AlertDescription>
		</Alert>
	)
}
