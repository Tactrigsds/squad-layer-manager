import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import * as RPC from '@/orpc.client'
import { AlertCircle, Loader2 } from 'lucide-react'
import React from 'react'

// a suspended component never commits, so it can't time itself out; the fallback is the only thing mounted while
// we wait, which makes it the only place that can tell the user the wait has gone on too long. The hard failure
// path is the stream's first-emit guard (see RxHelpers.bind), which lands here as a StateTimeoutError.

function SlowAwareFallback(props: { label: string; slowAfterMs: number }) {
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
				{!slow && `Loading ${props.label}…`}
				{slow && connectStatus === 'open' && `Still waiting on ${props.label}…`}
				{slow && connectStatus !== 'open' && `Reconnecting, ${props.label} will load once we're back…`}
			</span>
		</div>
	)
}

function StateErrorFallback(props: { label: string; error: unknown; reset: () => void }) {
	const timedOut = props.error instanceof RxHelpers.StateTimeoutError
	const message = props.error instanceof Error ? props.error.message : String(props.error)

	return (
		<Alert variant="destructive">
			<AlertCircle className="h-4 w-4" />
			<AlertTitle>{timedOut ? `${props.label} didn't load` : `${props.label} failed`}</AlertTitle>
			<AlertDescription className="space-y-2">
				<p>{timedOut ? 'The server never sent this data. It may be busy or in a bad state.' : message}</p>
				<Button size="sm" variant="outline" onClick={props.reset}>Retry</Button>
			</AlertDescription>
		</Alert>
	)
}

// router-wide net. Without a pending component TanStack doesn't wrap a match in Suspense at all, so a single
// suspending stream anywhere in a route would bubble to the root boundary and blank the whole app.
export function RoutePendingComponent() {
	return <SlowAwareFallback label="this page" slowAfterMs={4_000} />
}

export function RouteErrorComponent(props: { error: unknown; reset: () => void }) {
	return (
		<div className="p-4">
			<StateErrorFallback label="This page" error={props.error} reset={props.reset} />
		</div>
	)
}

// clearing the error re-renders the children, whose hook resubscribes the state observable. That's the whole retry: an
// errored state observable has already reset itself (@rx-state/core clears its subject), so a fresh subscriber re-runs
// the source from scratch.
type ErrorCatcherState = { hasError: boolean; error: unknown }

class ErrorCatcher extends React.Component<{ label: string; children: React.ReactNode }, ErrorCatcherState> {
	override state: ErrorCatcherState = { hasError: false, error: undefined }

	static getDerivedStateFromError(error: unknown): ErrorCatcherState {
		return { hasError: true, error }
	}

	private reset = () => this.setState({ hasError: false, error: undefined })

	override render() {
		if (!this.state.hasError) return this.props.children
		return <StateErrorFallback label={this.props.label} error={this.state.error} reset={this.reset} />
	}
}

/**
 * Suspense + error boundary for subtrees that read suspending StateObservables (`RxHelpers.bind` without a default).
 * Retry resets the boundary, which drops the last subscriber and resubscribes the state observable from scratch.
 */
export function StateBoundary(
	props: { label: string; children: React.ReactNode; slowAfterMs?: number; fallback?: React.ReactNode },
) {
	return (
		<ErrorCatcher label={props.label}>
			<React.Suspense fallback={props.fallback ?? <SlowAwareFallback label={props.label} slowAfterMs={props.slowAfterMs ?? 4_000} />}>
				{props.children}
			</React.Suspense>
		</ErrorCatcher>
	)
}
