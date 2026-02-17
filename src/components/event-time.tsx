import * as dateFns from 'date-fns'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface EventTimeProps {
	time: number
	variant?: 'default' | 'small'
}

export function EventTime({ time }: EventTimeProps) {
	const formattedTime = dateFns.format(time, 'HH:mm')

	return (
		<Tooltip>
			<TooltipTrigger>
				<span className="text-muted-foreground font-mono text-xs">{formattedTime}</span>
			</TooltipTrigger>
			<TooltipContent>
				{dateFns.format(time, 'yyyy-MM-dd HH:mm:ss zzz')}
			</TooltipContent>
		</Tooltip>
	)
}
