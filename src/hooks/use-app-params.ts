import { useParams } from 'react-router-dom'

import { Route, routes } from '@/app-routes'

type AppParams<R extends Route<'server'>> = Record<(typeof routes)[R]['params'][number], string>

export default function useAppParams<R extends Route<'server'>>(_route: R) {
	const params = useParams() as AppParams<R>
	return params
}
