import * as Atoms from './feed/atoms'

interface EventTimeProps {
	time: number
	variant?: 'default' | 'small'
}

export function EventTime({ time }: EventTimeProps) {
	return (
		<span className="contents">
			<Atoms.EventTime time={time} />
		</span>
	)
}
