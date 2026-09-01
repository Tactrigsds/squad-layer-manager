import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as SM from '@/models/squad.models'

import * as Atoms from './feed/atoms'
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
 * The markup and every interaction on it are Atoms.PlayerDisplay's; this supplies the scope. The activity feed
 * renders the same template to strings without any per-name react at all, which is the point -- a feed names
 * hundreds of players, and this component costs a battlemetrics subscription each.
 */
export function PlayerDisplay(props: PlayerDisplayProps) {
	const ctx = useRenderCtx(props.stores)
	const { player, showTeam, showSquad, showRole, className, matchId, disableContextMenu } = props
	return (
		<span className="contents" {...{ [SCOPE_ATTR]: ctx.scopeId }}>
			<Atoms.PlayerDisplay
				ctx={ctx}
				player={player}
				showTeam={showTeam}
				showSquad={showSquad}
				showRole={showRole}
				className={className}
				matchId={matchId}
				disableContextMenu={disableContextMenu}
			/>
		</span>
	)
}
