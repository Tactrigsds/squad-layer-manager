import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card'
import * as Icons from 'lucide-react'
import * as Typography from '@/lib/typography'

import * as AR from '@/app-routes.ts'
import * as M from '@/models'
import { useFilters } from '@/hooks/filters'

import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const filtersRes = useFilters({ parts: ['users'] })
	const filters = filtersRes.data?.filters
	const users = filtersRes.data?.parts.users as M.User[] | undefined
	return (
		<div className="container mx-auto py-8">
			<div className="mb-4 flex justify-between">
				<h2 className={Typography.H2}>Filters</h2>
				<Link className={buttonVariants({ variant: 'secondary' })} to={AR.link('/filters/new')}>
					New Filter
				</Link>
			</div>
			<ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{filters?.map((filter) => {
					const user = users?.find((u) => u.discordId === filter.owner)
					return (
						<li key={filter.id}>
							<Link to={AR.link('/filters/:id/edit', filter.id)} className="block h-full">
								<Card className="h-full transition-shadow hover:shadow-md ">
									<CardHeader>
										<CardTitle>{filter.name}</CardTitle>
										<CardDescription>{filter.description}</CardDescription>
									</CardHeader>
									<CardFooter>
										<p className="text-sm">Owner: {user?.username}</p>
									</CardFooter>
								</Card>
							</Link>
						</li>
					)
				})}
			</ul>
		</div>
	)
}
