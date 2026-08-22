import { useQuery } from '@tanstack/react-query'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useIsDesktopSize } from '@/lib/browser'
import * as Zus from '@/lib/zustand'
import * as TUT_Msgs from '@/messages/tutorials.messages'
import * as TUT from '@/models/tutorial.models'
import { tr } from '@/systems/messages.client'
import * as Tour from '@/systems/tour.client'
import * as TutorialsClient from '@/systems/tutorials.client'

// The tutorials a page recommends, offered when it opens. Which page offers what is TUT.RECOMMENDED_TUTORIALS;
// this dialog is the same on all of them.
//
// It keeps asking until the reader either finishes the list or dismisses it, and the dismissal is per user rather
// than per browser, so it holds on their next machine. Closing without dismissing is deliberately not remembered:
// someone who was busy the first time gets one more offer.

export default function RecommendedTutorialsDialog(props: { surface: TUT.SurfaceId }) {
	const scenarios = useQuery(TutorialsClient.scenariosQueryOptions)
	const progress = useQuery(TutorialsClient.progressQueryOptions)
	const dismissed = useQuery(TutorialsClient.dismissedPromptsQueryOptions)
	const run = TutorialsClient.useRunState()
	const narrating = Zus.useStore(Tour.Store, (s) => s.state.code !== 'idle')
	const desktopSize = useIsDesktopSize()
	const checkboxId = React.useId()

	const [closed, setClosed] = React.useState(false)
	const [dismissing, setDismissing] = React.useState(false)

	const unfinished = (scenarios.data ?? []).filter(
		(meta) =>
			TUT.RECOMMENDED_TUTORIALS[props.surface].includes(meta.id) &&
			meta.id in TUT_Msgs.scenarios &&
			!(progress.data ?? []).some((p) => p.scenarioId === meta.id && p.completed),
	)

	const open =
		!closed &&
		// a tutorial drives this same page, so prompting during one puts the dialog on top of the tour's own step
		run.code === 'none' &&
		!narrating &&
		// the tour needs the room, and the index page says as much before anyone starts one
		desktopSize &&
		progress.isSuccess &&
		dismissed.isSuccess &&
		!dismissed.data.includes(props.surface) &&
		unfinished.length > 0

	function close() {
		setClosed(true)
		if (dismissing) void TutorialsClient.Actions.dismissPrompt(props.surface)
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{tr.text(TUT_Msgs.recommendedTitle(tr.text(TUT_Msgs.surfaces[props.surface]())))}</DialogTitle>
					<DialogDescription>{tr.text(TUT_Msgs.recommendedBlurb())}</DialogDescription>
				</DialogHeader>
				<ul>
					{unfinished.map((meta) => {
						const copy = TUT_Msgs.scenarios[meta.id]
						const resumeAt = (progress.data ?? []).find((p) => p.scenarioId === meta.id)?.stepId
						return (
							<li key={meta.id} className="flex items-center gap-4 border-t py-3 last:border-b">
								<div className="min-w-0 grow">
									<div className="font-medium">{tr.text(copy.name())}</div>
									<p className="text-sm text-muted-foreground">{tr.text(copy.summary())}</p>
								</div>
								<span className="text-xs text-muted-foreground">{tr.text(TUT_Msgs.duration(meta.minutes))}</span>
								<Button
									size="sm"
									onClick={() => {
										setClosed(true)
										void (resumeAt ? Tour.Actions.resume(meta.id, resumeAt) : Tour.Actions.start(meta.id))
									}}
								>
									{tr.text(resumeAt ? TUT_Msgs.resume() : TUT_Msgs.start())}
								</Button>
							</li>
						)
					})}
				</ul>
				<DialogFooter className="items-center sm:justify-between">
					<div className="flex items-center gap-2">
						<Checkbox id={checkboxId} checked={dismissing} onCheckedChange={(checked) => setDismissing(checked === true)} />
						<Label htmlFor={checkboxId} className="text-sm font-normal text-muted-foreground">
							{tr.text(TUT_Msgs.dontShowAgain())}
						</Label>
					</div>
					<Button variant="ghost" onClick={close}>
						{tr.text(TUT_Msgs.notNow())}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
