import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand.ts'
import type * as UP from '@/models/user-presence'
import * as UPClient from '@/systems/user-presence.client'
import React from 'react'

type ChildPropsBase = {
	ref?: React.Ref<any>
	onClick: () => void
	onMouseEnter: () => void
	onMouseLeave: () => void
}

export function StartActivityInteraction<
	Loader extends UPClient.ConfiguredLoaderConfig = UPClient.ConfiguredLoaderConfig,
	Component extends React.FunctionComponent<ChildPropsBase> = never,
>(
	_props: {
		loaderName: Loader['name']
		createActivity: (root: UP.RootActivity) => UP.RootActivity
		matchKey: (predicate: UPClient.LoaderCacheKey<Loader>) => boolean

		preload: 'intent' | 'viewport' | 'render'
		intentDelay?: number
		render: Component
		ref?: any
	} & Omit<React.ComponentProps<Component>, keyof ChildPropsBase>,
) {
	const eltRef = React.useRef<Element | null>(null)
	const [props, otherEltProps] = Obj.partition(
		_props,
		// stop ref from being passed to child so we don't get into weird situations
		'ref',
		'loaderName',
		'createActivity',
		'matchKey',
		'preload',
		'intentDelay',
		'render',
	)
	const [isLoaded, _isActive] = UPClient.useActivityLoaderData({
		loaderName: props.loaderName,
		matchKey: props.matchKey,
		trace: `StartActivityInteraction:${props.loaderName}`,
		select: ZusUtils.useShallow(entry => [!!entry?.data, !!entry?.active] as const),
	})

	const startActivity = () => {
		return UPClient.PresenceStore.getState().updateActivity(props.createActivity)
	}

	// NOTE: preloadActivity should be implemented such that it runs the work lazily

	const preloadActivity = React.useCallback(
		async () => {
			// this is mostly redundant(maybe slightly better perf) but shows intent
			if (isLoaded) return

			UPClient.PresenceStore.getState().preloadActivity(props.createActivity)
		},
		[props.createActivity, isLoaded],
	)

	const [intentTimeout, setIntentTimeout] = React.useState<NodeJS.Timeout | null>(null)

	React.useEffect(() => {
		// preloadActivity depends on isLoaded above
		if (props.preload === 'render') {
			void preloadActivity()
		}
	}, [props.preload, preloadActivity])

	React.useEffect(() => {
		if (props.preload !== 'viewport' || !eltRef.current || isLoaded) return

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						void preloadActivity()
					}
				})
			},
			{ threshold: 0.1 }, // Trigger when 10% of the element is visible
		)

		observer.observe(eltRef.current as unknown as Element)

		return () => {
			observer.disconnect()
		}
	}, [props.preload, preloadActivity, eltRef, isLoaded])

	const handleMouseEnter = () => {
		if (props.preload === 'intent' && !isLoaded) {
			const delay = props.intentDelay ?? 150
			const timeout = setTimeout(() => {
				void preloadActivity()
			}, delay)
			setIntentTimeout(timeout)
		}
	}

	const handleMouseLeave = () => {
		if (intentTimeout) {
			clearTimeout(intentTimeout)
			setIntentTimeout(null)
		}
	}

	const handleClick = () => {
		startActivity()
	}

	const childProps = {
		...otherEltProps,
		ref: eltRef,
		onClick: handleClick,
		onMouseEnter: handleMouseEnter,
		onMouseLeave: handleMouseLeave,
	} as any

	return <props.render {...childProps} />
}
