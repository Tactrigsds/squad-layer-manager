import { TRIGGER_LEVEL_DISPLAY } from '@/lib/balance-trigger-display'
import { cn } from '@/lib/utils'
import * as Messages from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import type * as MH from '@/models/match-history.models'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export default function BalanceTriggerAlert(
	props: { event: BAL.BalanceTriggerEvent; referenceMatch: MH.MatchDetails; className?: string },
) {
	if (!BAL.isKnownEventInstance(props.event)) return null
	const trigger = BAL.TRIGGERS[props.event.triggerId]
	if (!trigger) return null
	const display = TRIGGER_LEVEL_DISPLAY[props.event.level]
	const AlertIcon = display.icon
	return (
		<Alert variant={display.variant} key={props.event.id} className={cn('w-full bg-background!', props.className)}>
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
