import { useQuery } from '@tanstack/react-query'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'

import * as Typo from '@/components/typography'
import { Button } from '@/components/ui/button'
import * as Zus from '@/lib/zustand'
import * as PLUGINS_Msgs from '@/messages/plugins.messages'
import type * as SJOB from '@/models/scheduled-jobs.models'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as SettingsClient from '@/systems/settings.client'

// A running plugin's scheduled jobs: when each next runs and how its last run went, and the one-off runs it has
// scheduled, each of which can be run now or cancelled.
export function PluginJobs(props: { pluginId: string }) {
	const res = useQuery(PluginsClient.jobsQuery(props.pluginId)).data
	const jobs = res?.code === 'ok' ? res.jobs : []
	if (jobs.length === 0) return null
	return (
		<section aria-label={tr.text(PLUGINS_Msgs.jobsTitle())} className="space-y-2">
			<div className="space-y-0.5">
				<h3 className="text-sm font-medium">{tr.text(PLUGINS_Msgs.jobsTitle())}</h3>
				<p className="text-xs text-muted-foreground">{tr.text(PLUGINS_Msgs.jobsBlurb())}</p>
			</div>
			<ul className="space-y-2">
				{jobs.map((job) => (
					<JobEntry key={job.id} pluginId={props.pluginId} job={job} />
				))}
			</ul>
		</section>
	)
}

function useServerName() {
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)
	return (serverId: string | null) =>
		serverId === null ? tr.text(PLUGINS_Msgs.jobPluginWide()) : (servers?.find((s) => s.id === serverId)?.displayName ?? serverId)
}

function when(time: number) {
	return `${dateFns.format(time, 'EEE d MMM, HH:mm')} (${dateFns.formatDistanceToNow(time, { addSuffix: true })})`
}

function lastRun(last: SJOB.JobView['targets'][number]['last']) {
	if (!last || last.finishedAt === null) return tr.text(PLUGINS_Msgs.jobNeverRun())
	if (last.state === 'failed') return tr.text(PLUGINS_Msgs.jobLastFailed(when(last.finishedAt), last.error ?? ''))
	if (last.state === 'skipped') return tr.text(PLUGINS_Msgs.jobLastSkipped(when(last.finishedAt), last.error ?? ''))
	if (last.state === 'cancelled') return tr.text(PLUGINS_Msgs.jobLastCancelled(when(last.finishedAt)))
	return tr.text(
		last.manual ? PLUGINS_Msgs.jobLastSucceededManual(when(last.finishedAt)) : PLUGINS_Msgs.jobLastSucceeded(when(last.finishedAt)),
	)
}

function pendingStatus(run: SJOB.JobView['pending'][number]) {
	if (run.state === 'running') return tr.text(run.cancelling ? PLUGINS_Msgs.jobStopping() : PLUGINS_Msgs.jobRunning())
	if (run.state === 'blocked') {
		const reason = run.blockedReason ?? ''
		return run.nextAttemptAt === null
			? tr.text(PLUGINS_Msgs.jobWaiting(reason))
			: tr.text(PLUGINS_Msgs.jobWaitingUntil(when(run.nextAttemptAt), reason))
	}
	if (run.state === 'retrying' && run.nextAttemptAt !== null) {
		return tr.text(PLUGINS_Msgs.jobPendingRetrying(when(run.nextAttemptAt), run.attempt + 1))
	}
	return tr.text(PLUGINS_Msgs.jobPendingDue(when(run.dueAt)))
}

function StopButton(props: { disabled: boolean; label: string; onClick: () => void }) {
	return (
		<Button size="sm" variant="ghost" disabled={props.disabled} aria-label={props.label} onClick={props.onClick}>
			<Icons.Square />
			{tr.text(PLUGINS_Msgs.jobStop())}
		</Button>
	)
}

function JobEntry(props: { pluginId: string; job: SJOB.JobView }) {
	const { job, pluginId } = props
	const serverName = useServerName()
	return (
		<li className="space-y-1.5 rounded border p-2">
			<p className="font-mono text-sm ltr-isolate">{job.id}</p>
			{job.targets.length > 0 && (
				<ul className="space-y-1">
					{job.targets.map((target) => (
						<li key={target.serverId ?? ''} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
							<span className="font-medium">{serverName(target.serverId)}</span>
							{job.recurring && (
								<span className="text-muted-foreground">
									{target.nextRunAt === null
										? tr.text(PLUGINS_Msgs.jobNotScheduled())
										: tr.text(PLUGINS_Msgs.jobNextRun(when(target.nextRunAt)))}
								</span>
							)}
							{target.blockedReason !== null && (
								<span className="text-warning">{tr.text(PLUGINS_Msgs.jobWaiting(target.blockedReason))}</span>
							)}
							<span className={target.last?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
								{lastRun(target.last)}
							</span>
							{target.running && (
								<span className="text-muted-foreground">
									{tr.text(target.running.cancelling ? PLUGINS_Msgs.jobStopping() : PLUGINS_Msgs.jobRunning())}
								</span>
							)}
							<span className="flex-1" />
							{target.running && (
								<StopButton
									disabled={target.running.cancelling}
									label={tr.text(PLUGINS_Msgs.jobStopLabel(job.id, serverName(target.serverId)))}
									onClick={() => void PluginsClient.Actions.cancelJobRun(pluginId, job.id, target.serverId, target.running!.key)}
								/>
							)}
							{job.recurring && (
								<Button
									size="sm"
									variant="outline"
									aria-label={tr.text(PLUGINS_Msgs.jobRunNowLabel(job.id, serverName(target.serverId)))}
									onClick={() => void PluginsClient.Actions.runJobNow(pluginId, job.id, target.serverId, null)}
								>
									<Icons.Play />
									{tr.text(PLUGINS_Msgs.jobRunNow())}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			{job.pending.length > 0 && (
				<div className="space-y-1">
					<p className={Typo.Label}>{tr.text(PLUGINS_Msgs.jobPendingTitle())}</p>
					<ul className="space-y-1">
						{job.pending.map((run) => (
							<li key={`${run.serverId ?? ''}|${run.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
								<span className="font-mono ltr-isolate">{run.key}</span>
								<span className="font-medium">{serverName(run.serverId)}</span>
								<span className={run.state === 'blocked' ? 'text-warning' : 'text-muted-foreground'}>{pendingStatus(run)}</span>
								<span className="flex-1" />
								<Button
									size="sm"
									variant="outline"
									disabled={run.state === 'running'}
									aria-label={tr.text(PLUGINS_Msgs.jobRunNowLabel(`${job.id} ${run.key}`, serverName(run.serverId)))}
									onClick={() => void PluginsClient.Actions.runJobNow(pluginId, job.id, run.serverId, run.key)}
								>
									<Icons.Play />
									{tr.text(PLUGINS_Msgs.jobRunNow())}
								</Button>
								{run.state === 'running' ? (
									<StopButton
										disabled={run.cancelling}
										label={tr.text(PLUGINS_Msgs.jobStopLabel(`${job.id} ${run.key}`, serverName(run.serverId)))}
										onClick={() => void PluginsClient.Actions.cancelJobRun(pluginId, job.id, run.serverId, run.key)}
									/>
								) : (
									<Button
										size="sm"
										variant="ghost"
										aria-label={tr.text(PLUGINS_Msgs.jobCancelLabel(run.key, job.id))}
										onClick={() => void PluginsClient.Actions.cancelJobRun(pluginId, job.id, run.serverId, run.key)}
									>
										<Icons.X />
										{tr.text(PLUGINS_Msgs.jobCancel())}
									</Button>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</li>
	)
}
