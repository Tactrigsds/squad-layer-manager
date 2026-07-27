import { AlertCircle, Loader2 } from 'lucide-react'
import React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import * as ReactRx from '@/lib/react-rxjs'
import * as APP_Msgs from '@/messages/app.messages'
import * as RPC from '@/orpc.client'

// a suspended component never commits, so it can't time itself out; the fallback is the only thing mounted while
// we wait, which makes it the only place that can tell the user the wait has gone on too long. The hard failure
// path is the stream's first-emit guard (see ReactRx.bind), which lands here as a StateTimeoutError.

function SlowAwareFallback(props: { subject: APP_Msgs.BoundarySubject; slowAfterMs: number }) {
	const [slow, setSlow] = React.useState(false)
	const connectStatus = RPC.useConnectStatus()

	React.useEffect(() => {
		const handle = setTimeout(() => setSlow(true), props.slowAfterMs)
		return () => clearTimeout(handle)
	}, [props.slowAfterMs])

	return (
		<div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
			<Loader2 className="h-4 w-4 animate-spin" />
			<span>
				{APP_Msgs.boundaryLoading(props.subject, !slow ? 'waiting' : connectStatus === 'open' ? 'slow' : 'reconnecting').text()}
			</span>
		</div>
	)
}

function StateErrorFallback(props: { subject: APP_Msgs.BoundarySubject; error: unknown; reset: () => void }) {
	const timedOut = props.error instanceof ReactRx.StateTimeoutError
	const message = props.error instanceof Error ? props.error.message : String(props.error)

	return (
		<Alert variant="destructive">
			<AlertCircle className="h-4 w-4" />
			<AlertTitle>{APP_Msgs.boundaryFailed(props.subject, timedOut).text()}</AlertTitle>
			<AlertDescription className="space-y-2">
				<p>{timedOut ? APP_Msgs.boundaryTimedOutBlurb().text() : message}</p>
				<Button size="sm" variant="outline" onClick={props.reset}>
					{APP_Msgs.retry().text()}
				</Button>
			</AlertDescription>
		</Alert>
	)
}

// router-wide net. Without a pending component TanStack doesn't wrap a match in Suspense at all, so a single
// suspending stream anywhere in a route would bubble to the root boundary and blank the whole app.
export function RoutePendingComponent() {
	// fills the route outlet rather than sitting at its start, so the spinner lands in the middle of the page area
	return (
		<div className="flex flex-1 h-full w-full items-center justify-center gap-2 p-2 text-sm text-muted-foreground">
			<Spinner />
			{import.meta.env.DEV && <span>{APP_Msgs.routeSuspended().text()}</span>}
		</div>
	)
}

export function RouteErrorComponent(props: { error: unknown; reset: () => void }) {
	return (
		<div className="p-4">
			<StateErrorFallback subject="page" error={props.error} reset={props.reset} />
		</div>
	)
}

// clearing the error re-renders the children, whose hook resubscribes the state observable. That's the whole retry: an
// errored state observable has already reset itself (@rx-state/core clears its subject), so a fresh subscriber re-runs
// the source from scratch.
type ErrorCatcherState = { hasError: boolean; error: unknown }

class ErrorCatcher extends React.Component<{ subject: APP_Msgs.BoundarySubject; children: React.ReactNode }, ErrorCatcherState> {
	override state: ErrorCatcherState = { hasError: false, error: undefined }

	static getDerivedStateFromError(error: unknown): ErrorCatcherState {
		return { hasError: true, error }
	}

	private reset = () => this.setState({ hasError: false, error: undefined })

	override render() {
		if (!this.state.hasError) return this.props.children
		return <StateErrorFallback subject={this.props.subject} error={this.state.error} reset={this.reset} />
	}
}

/**
 * Suspense + error boundary for subtrees that read suspending StateObservables (`ReactRx.bind` without a default).
 * Retry resets the boundary, which drops the last subscriber and resubscribes the state observable from scratch.
 */
export function StateBoundary(props: {
	subject: APP_Msgs.BoundarySubject
	children: React.ReactNode
	slowAfterMs?: number
	fallback?: React.ReactNode
}) {
	return (
		<ErrorCatcher subject={props.subject}>
			<React.Suspense
				fallback={props.fallback ?? <SlowAwareFallback subject={props.subject} slowAfterMs={props.slowAfterMs ?? 4_000} />}
			>
				{props.children}
			</React.Suspense>
		</ErrorCatcher>
	)
}
