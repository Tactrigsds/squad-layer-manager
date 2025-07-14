import { Unsubscribable } from '@trpc/server/observable'
import * as Rx from 'rxjs'

type SubscribeFn<I, D> = (
	input: I,
	opts: { onData: (data: D) => void; onComplete: () => void; onError: (err: any) => void },
) => Unsubscribable
export function fromTrpcSub<I, D>(input: I, subscribeFn: SubscribeFn<I, D>) {
	return new Rx.Observable<D>((s) => {
		const sub = subscribeFn(input, {
			onData: (data) => {
				s.next(data)
			},
			onComplete: () => {
				s.complete()
			},
			onError: err => s.error(err),
		})
		return () => {
			return sub.unsubscribe()
		}
	})
}
