import * as React from 'react'

import * as Zus from '@/lib/zustand'
import { BaseZIndexContext } from '@/models/zindex'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import { DraggableWindowOutletContext } from '@/systems/draggable-window.client'

import LayerContextMenuOptions from '../layer-context-menu-options'
import PlayerContextMenuOptions from '../player-context-menu-options'
import SquadContextMenuOptions from '../squad-context-menu-options'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu'
import { TrackingTooltip } from '../ui/tracking-tooltip'
import * as Interactions from './interactions'
import MatchTip from './match-tip'

// off the page and out of the way of the pointer; the menu's placement comes from the event point radix reads off
// the re-fired contextmenu, and the tooltip's from the rect written onto this node
const ANCHOR_STYLE: React.CSSProperties = { position: 'fixed', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' }

/**
 * The one context menu and the one tooltip every dom-built row shares.
 *
 * Mounted once, near the root, and moved to whatever the pointer is on. Both are the same radix primitives a row
 * would otherwise have mounted per instance, so placement, dismissal and focus handling are unchanged -- what
 * changes is that there is one of each rather than one per player mention.
 */
export function DomOverlays() {
	return (
		<>
			<MenuOverlay />
			<TipOverlay />
		</>
	)
}

function MenuOverlay() {
	const menu = Zus.useStore(Interactions.OverlayStore, (s) => s.menu)
	const anchor = React.useCallback((node: HTMLSpanElement | null) => {
		Interactions.setMenuAnchor(node)
	}, [])

	return (
		// the row's own stacking context, so a menu opened from inside a draggable window clears it
		<BaseZIndexContext.Provider value={menu?.zIndexBase ?? 0}>
			<DraggableWindowOutletContext.Provider value={OUTLET}>
				<ContextMenu>
					<ContextMenuTrigger ref={anchor} aria-hidden style={ANCHOR_STYLE} />
					<ContextMenuContent>
						{menu?.target.kind === 'player' && <PlayerContextMenuOptions playerId={menu.target.playerId} stores={menu.stores} />}
						{menu?.target.kind === 'squad' && menu.stores && (
							<SquadContextMenuOptions squad={menu.target.squad} stores={menu.stores} />
						)}
						{menu?.target.kind === 'layer' && (
							<LayerContextMenuOptions layerIds={menu.target.layerIds} historyEntryIds={menu.target.historyEntryIds} />
						)}
					</ContextMenuContent>
				</ContextMenu>
			</DraggableWindowOutletContext.Provider>
		</BaseZIndexContext.Provider>
	)
}

// a menu opened from a row belongs to the outlet the app's own windows do; a row inside a draggable window is the
// only case that would differ, and one there opening into the page rather than into the window is the better answer
const OUTLET = { outletKey: 'default' }

/**
 * The one tooltip every dom-built row shares.
 *
 * Follows the pointer rather than anchoring, and opens with no delay: a feed's hover targets are a timestamp
 * and a three-character id badge, which is what TrackingTooltip is for. Pinning is what makes the match
 * tooltip's layer link reachable; interactions.ts owns when that happens.
 */
function TipOverlay() {
	const tip = Zus.useStore(Interactions.OverlayStore, (s) => s.tip)
	const open = Zus.useStore(Interactions.OverlayStore, (s) => s.tipOpen)
	const anchor = Zus.useStore(Interactions.OverlayStore, (s) => s.tipAnchor)
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const nodeRef = React.useRef<HTMLDivElement | null>(null)

	React.useEffect(() => {
		Interactions.setTipContentNode(nodeRef.current)
	})

	let content: React.ReactNode = null
	if (open && tip?.content.kind === 'match') {
		content = <MatchTip details={tip.content.details} displayTeamsNormalized={displayTeamsNormalized} />
	} else if (open && tip?.content.kind === 'text') {
		content = tip.content.heading ? (
			<div>
				<div className="font-semibold">{tip.content.heading}</div>
				<div className="text-muted-foreground mt-1">{tip.content.text}</div>
			</div>
		) : (
			tip.content.text
		)
	}

	return (
		<BaseZIndexContext.Provider value={tip?.zIndexBase ?? 0}>
			<TrackingTooltip
				content={content}
				nodeRef={nodeRef}
				anchor={anchor}
				interactive={anchor !== null}
				// a match restates a whole layer, both sides included, which the default tooltip width folds
				// onto four lines
				className={tip?.content.kind === 'match' ? 'max-w-lg' : undefined}
			/>
		</BaseZIndexContext.Provider>
	)
}
