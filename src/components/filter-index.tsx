import * as AR from '@/app-routes.ts'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import * as Typography from '@/lib/typography'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import EmojiDisplay from './emoji-display'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Badge } from './ui/badge'
import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const cfg = ConfigClient.useEffectiveColConfig()

	const filterEntities = FilterEntityClient.useFilterEntities()
	const filters = Array.from(filterEntities.values()).sort((a, b) => {
		if (a.emoji && !b.emoji) return -1
		if (!a.emoji && b.emoji) return 1
		return a.name.localeCompare(b.name)
	})
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
				{filters.map((entity) => {
					const user = PartsSys.findUser(entity.owner)!
					const onHover = () => {
						LayerQueriesClient.prefetchLayersQuery(
							LayerQueriesClient.getLayerQueryInput({ constraints: [LQY.getEditedFilterConstraint(entity.filter)] }, { cfg }),
						)
					}
					return (
						<li key={entity.id}>
							<Item variant="outline" className="h-full transition-none hover:shadow-md hover:border-primary/50" asChild>
								<Link onMouseEnter={onHover} to={AR.link('/filters/:id', entity.id)}>
									{entity.emoji && (
										<ItemMedia>
											<EmojiDisplay emoji={entity.emoji} />
										</ItemMedia>
									)}
									<ItemContent>
										<ItemTitle>{entity.name}</ItemTitle>
										<ItemDescription>{entity.description?.split('\n')[0]}</ItemDescription>
									</ItemContent>
									<ItemActions className="">
										<Badge variant="secondary" className="flex items-center gap-1.5">
											<Avatar
												style={{ backgroundColor: user.displayHexColor ?? undefined }}
												className="hover:cursor-pointer select-none h-5 w-5 flex-shrink-0"
											>
												<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
												<AvatarFallback className="text-xs">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
											</Avatar>
											<span>
												{user?.displayName}
											</span>
										</Badge>
									</ItemActions>
								</Link>
							</Item>
						</li>
					)
				})}
			</ul>
		</div>
	)
}
