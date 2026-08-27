import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as SM from '@/models/squad.models'

import * as Atoms from './feed/atoms'
import { useDomContent } from './feed/dom-content'
import { SCOPE_ATTR } from './feed/render-context'
import { useRenderCtx } from './feed/use-render-ctx'

interface SquadDisplayProps {
	squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number }
	className?: string
	showName?: boolean
	showTeam?: boolean
	showMenu?: boolean
	matchId: number
	stores: SquadServerFrame.KeyProp
}

/** A squad's name and team. See PlayerDisplay: the markup and interactions are Atoms.squadDisplay's. */
export function SquadDisplay(props: SquadDisplayProps) {
	const ctx = useRenderCtx(props.stores)
	const { squad, className, showName, showTeam, showMenu, matchId } = props
	const node = React.useMemo(
		() => Atoms.squadDisplay(ctx, { squad, className, showName, showTeam, showMenu, matchId }),
		[ctx, squad, className, showName, showTeam, showMenu, matchId],
	)
	const ref = useDomContent<HTMLSpanElement>(node)
	return <span ref={ref} className="contents" {...{ [SCOPE_ATTR]: ctx.scopeId }} />
}
