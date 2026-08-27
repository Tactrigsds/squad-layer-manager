import React from 'react'

import * as Atoms from './feed/atoms'
import { useDomContent } from './feed/dom-content'

interface EventTimeProps {
	time: number
	variant?: 'default' | 'small'
}

export function EventTime({ time }: EventTimeProps) {
	const ref = useDomContent<HTMLSpanElement>(React.useMemo(() => Atoms.eventTime(time), [time]))
	return <span ref={ref} className="contents" />
}
