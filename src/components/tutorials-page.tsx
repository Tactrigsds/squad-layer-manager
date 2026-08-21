import { useQuery } from '@tanstack/react-query'
import * as TSR from '@tanstack/react-router'
import React from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useIsDesktopSize, useIsSmallViewport } from '@/lib/browser'
import * as Zus from '@/lib/zustand'
import * as TUT_Msgs from '@/messages/tutorials.messages'
import type * as TUT from '@/models/tutorial.models'
import { tr } from '@/systems/messages.client'
import * as Tour from '@/systems/tour.client'
import * as TutorialsClient from '@/systems/tutorials.client'

// The tutorials index: what a run is, which ones exist, and the one control that starts them. The catalogue and
// the run come from the server; a tutorial's name and summary are copy (TUT_Msgs.scenarios), so a scenario the
// server advertises but this file has no name for is not shown rather than shown untitled.

export default function TutorialsPage() {
	const scenarios = useQuery(TutorialsClient.scenariosQueryOptions)
	const run = TutorialsClient.useRunState()
	const progress = useQuery(TutorialsClient.progressQueryOptions)
	const smallViewport = useIsSmallViewport()
	const desktopSize = useIsDesktopSize()

	const listed = (scenarios.data ?? []).filter((meta) => meta.id in TUT_Msgs.scenarios)

	return (
		<div className="mx-auto w-full max-w-2xl space-y-3 py-6">
			<h1 className="text-xl font-semibold">{tr.text(TUT_Msgs.pageTitle())}</h1>
			{!desktopSize && (
				<Alert variant="warning">
					<AlertDescription>{tr.text(smallViewport ? TUT_Msgs.deviceWarning() : TUT_Msgs.viewportSizeWarning())}</AlertDescription>
				</Alert>
			)}
			<Card className="py-0">
				<ul>
					{listed.map((meta) => (
						<li key={meta.id} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
							<TutorialRow meta={meta} run={run} progress={(progress.data ?? []).find((p) => p.scenarioId === meta.id)} />
						</li>
					))}
				</ul>
				{scenarios.isSuccess && listed.length === 0 && (
					<p className="px-4 py-3 text-sm text-muted-foreground">{tr.text(TUT_Msgs.noneAvailable())}</p>
				)}
			</Card>
		</div>
	)
}

function TutorialRow(props: { meta: TUT.ScenarioMeta; run: TUT.RunState; progress?: TUT.Progress }) {
	const { meta, run, progress } = props
	const completed = !!progress?.completed
	// somewhere to go back to: a place was saved, and it is not the tutorial's own beginning
	const resumeAt = !completed && progress?.stepId ? progress.stepId : null
	const copy = TUT_Msgs.scenarios[meta.id]
	const active = run.code === 'active' && run.scenarioId === meta.id
	const starting = run.code === 'starting' && run.scenarioId === meta.id
	// whether this tab still holds the tour, which is the difference between going back to a narration in progress
	// and rebuilding one from the reader's saved place
	const narrating = Zus.useStore(Tour.Store, (s) => s.state.code !== 'idle')
	const navigate = TSR.useNavigate()

	return (
		<>
			<div className="min-w-0 grow">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{tr.text(copy.name())}</span>
					{/* having finished it is the durable fact and wins the badge: a run outlives the last step, so the
					    reader who just pressed Finish would otherwise be told they are still in progress. That the
					    practice server is still up is what the buttons beside it say. */}
					{completed ? (
						<Badge variant="secondary">{tr.text(TUT_Msgs.completed())}</Badge>
					) : (
						active && <Badge variant="info">{tr.text(TUT_Msgs.inProgress())}</Badge>
					)}
				</div>
				<p className="text-sm text-muted-foreground">{tr.text(copy.summary())}</p>
				<p className="text-xs text-muted-foreground">{tr.text(TUT_Msgs.duration(meta.minutes))}</p>
			</div>
			{active && (
				<Button variant="ghost" size="sm" onClick={() => void Tour.Actions.exit()}>
					{tr.text(TUT_Msgs.leave())}
				</Button>
			)}
			{resumeAt ? (
				<>
					<Button variant="outline" size="sm" onClick={() => void Tour.Actions.start(meta.id)}>
						{tr.text(TUT_Msgs.replay())}
					</Button>
					<Button
						size="sm"
						disabled={starting}
						onClick={() =>
							narrating && active
								? void navigate({ to: '/servers/$serverId', params: { serverId: run.serverId } })
								: void Tour.Actions.resume(meta.id, resumeAt)
						}
					>
						{tr.text(TUT_Msgs.resume())}
					</Button>
				</>
			) : (
				<Button size="sm" disabled={starting} onClick={() => void Tour.Actions.start(meta.id)}>
					{tr.text(completed || active ? TUT_Msgs.replay() : TUT_Msgs.start())}
				</Button>
			)}
		</>
	)
}
