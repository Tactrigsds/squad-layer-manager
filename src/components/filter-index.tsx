import * as AR from '@/app-routes.ts'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import * as Typography from '@/lib/typography'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import EmojiDisplay from './emoji-display'
import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const cfg = ConfigClient.useEffectiveColConfig()

	const filterEntities = FilterEntityClient.useFilterEntities()
	return (
		<div className="container mx-auto py-8">
			<div className="mb-4 flex justify-between">
				<h2 className={Typography.H2}>Filters</h2>
				<Link className={buttonVariants({ variant: 'secondary' })} to={AR.link('/filters/new')}>
					<Icons.Plus />
					<span>New Filter</span>
				</Link>
			</div>
			<ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{[...filterEntities.values()]?.map((entity) => {
					const user = PartsSys.findUser(entity.owner)
					const onHover = () => {
						LayerQueriesClient.prefetchLayersQuery(
							LayerQueriesClient.getLayerQueryInput({ constraints: [LQY.getEditedFilterConstraint(entity.filter)] }, { cfg }),
						)
					}
					return (
						<li key={entity.id}>
							<Link onMouseEnter={onHover} to={AR.link('/filters/:id', entity.id)} className="block h-full">
								<Card className="h-full transition-shadow hover:shadow-md hover:bg-accent hover:text-accent-foreground overflow-hidden">
									<CardHeader>
										<div className="flex items-center space-x-1">
											{entity.emoji && <EmojiDisplay emoji={entity.emoji} />}
											<CardTitle>{entity.name}</CardTitle>
										</div>
										<CardDescription className="line-clamp-2">{entity.description?.split('\n')[0]}</CardDescription>
									</CardHeader>
									<CardFooter>
										<p className="text-sm">Owner: {user?.displayName}</p>
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
