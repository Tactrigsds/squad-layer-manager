import * as dateFns from 'date-fns'

interface EventTimeProps {
	time: number
	variant?: 'default' | 'small'
}

export function EventTime({ time }: EventTimeProps) {
	const formattedTime = dateFns.format(time, 'HH:mm')

	return <span className="text-muted-foreground font-mono text-xs">{formattedTime}</span>
}
