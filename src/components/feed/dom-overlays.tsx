import * as React from 'react'

import * as Zus from '@/lib/zustand'
import { BaseZIndexContext } from '@/models/zindex'
import { DraggableWindowOutletContext } from '@/systems/draggable-window.client'

import PlayerContextMenuOptions from '../player-context-menu-options'
import SquadContextMenuOptions from '../squad-context-menu-options'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import * as Interactions from './interactions'

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
						{menu?.target.kind === 'squad' && <SquadContextMenuOptions squad={menu.target.squad} stores={menu.stores} />}
					</ContextMenuContent>
				</ContextMenu>
			</DraggableWindowOutletContext.Provider>
		</BaseZIndexContext.Provider>
	)
}

// a menu opened from a row belongs to the outlet the app's own windows do; a row inside a draggable window is the
// only case that would differ, and one there opening into the page rather than into the window is the better answer
const OUTLET = { outletKey: 'default' }

function TipOverlay() {
	const tip = Zus.useStore(Interactions.OverlayStore, (s) => s.tip)
	const open = Zus.useStore(Interactions.OverlayStore, (s) => s.tipOpen)
	const rect = tip?.rect

	return (
		<BaseZIndexContext.Provider value={tip?.zIndexBase ?? 0}>
			<Tooltip open={open} onOpenChange={(next) => !next && Interactions.closeTip()}>
				<TooltipTrigger asChild>
					<span
						aria-hidden
						style={
							rect
								? {
										position: 'fixed',
										left: rect.left,
										top: rect.top,
										width: rect.width,
										height: rect.height,
										pointerEvents: 'none',
									}
								: ANCHOR_STYLE
						}
					/>
				</TooltipTrigger>
				<TooltipContent className="pointer-events-none">
					{tip?.content.heading ? (
						<div className="text-xs">
							<div className="font-semibold">{tip.content.heading}</div>
							<div className="text-muted-foreground mt-1">{tip.content.text}</div>
						</div>
					) : (
						tip?.content.text
					)}
				</TooltipContent>
			</Tooltip>
		</BaseZIndexContext.Provider>
	)
}
