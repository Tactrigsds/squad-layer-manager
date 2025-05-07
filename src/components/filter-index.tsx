import * as AR from '@/app-routes.ts'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import * as Typography from '@/lib/typography'
import * as M from '@/models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import * as ReactRx from '@react-rxjs/core'
import * as Icons from 'lucide-react'
import { Link } from 'react-router-dom'

import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const filters = FilterEntityClient.useFilterEntities()
	return (
		<div className="container mx-auto py-8">
			<div className="mb-4 flex justify-between">
				<h2 className={Typography.H2}>Filters</h2>
				<Link className={buttonVariants({ variant: 'secondary' })} to={AR.link('/filters/new')}>
					New Filter
				</Link>
			</div>
			<ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{[...filters.values()]?.map((filter) => {
					const user = PartsSys.findUser(filter.owner)
					return (
						<li key={filter.id}>
							<Link to={AR.link('/filters/:id', filter.id)} className="block h-full">
								<Card className="h-full transition-shadow hover:shadow-md hover:bg-accent hover:text-accent-foreground">
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
