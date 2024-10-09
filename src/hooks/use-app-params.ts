import { Route, routes } from '@/app-routes'
import { useParams } from 'react-router-dom'

type AppParams<R extends Route<'server'>> = Record<(typeof routes)[R]['params'][number], string>

export default function useAppParams<R extends Route<'server'>>() {
	const params = useParams() as AppParams<R>
	return params
}
