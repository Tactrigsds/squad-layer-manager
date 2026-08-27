import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as SM from '@/models/squad.models'

import * as Atoms from './feed/atoms'
import { useDomContent } from './feed/dom-content'
import { SCOPE_ATTR } from './feed/render-context'
import { useRenderCtx } from './feed/use-render-ctx'

export interface PlayerDisplayProps {
	player: SM.Player
	showTeam?: boolean
	showSquad?: boolean
	showRole?: boolean
	className?: string
	// only the team display needs it, so a caller showing neither team nor squad can omit it
	matchId?: number
	stores: SquadServerFrame.KeyProp
	// when true, the name doesn't offer a context menu so an enclosing one (e.g. the teams-panel row's bulk-aware
	// menu) handles the right-click instead
	disableContextMenu?: boolean
}

/**
 * A player's name, with their badges, team and squad.
 *
 * The markup and every interaction on it are Atoms.playerDisplay's; this mounts them. The activity feed builds the
 * same thing without going through react at all, which is the point -- a feed names hundreds of players, and this
 * component costs a context menu, a window preloader and a battlemetrics subscription each.
 */
export function PlayerDisplay(props: PlayerDisplayProps) {
	const ctx = useRenderCtx(props.stores)
	const { player, showTeam, showSquad, showRole, className, matchId, disableContextMenu } = props
	const node = React.useMemo(
		() => Atoms.playerDisplay(ctx, { player, showTeam, showSquad, showRole, className, matchId, disableContextMenu }),
		[ctx, player, showTeam, showSquad, showRole, className, matchId, disableContextMenu],
	)
	const ref = useDomContent<HTMLSpanElement>(node)
	return <span ref={ref} className="contents" {...{ [SCOPE_ATTR]: ctx.scopeId }} />
}
