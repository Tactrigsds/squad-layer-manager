import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

import React from 'react'

// /**
//  * @param select - must be a stable reference. should use useCallback whenever closures are present
//  */
// export function useStateObservableSelection<T, O>(o: ReactRx.StateObservable<T>, select: (value: T) => O) {
// 	const subRef = React.useRef<Rx.Subscription | undefined>()
// 	const piped$ = React.useMemo(() => {
// 		return o.pipeState(Rx.map(value => select(value)))
// 	}, [select, o])
// 	React.useEffect(() => {
// 		return () => {
// 			subRef.current?.unsubscribe()
// 			subRef.current = undefined
// 		}
// 	}, [])
// 	if (!subRef.current) {
// 		subRef.current = piped$.subscribe()
// 	}
// 	return ReactRx.useStateObservable(piped$)
// }
//

// this is all I can get to work atm unfortunately
export function useStateObservableSelection<T, O>(o: ReactRx.StateObservable<T>, select: (value: T) => O) {
	const valueRaw = ReactRx.useStateObservable(o)
	return React.useMemo(() => select(valueRaw), [select, valueRaw])
}
