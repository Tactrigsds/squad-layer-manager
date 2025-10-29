import * as AR from '@/app-routes.ts'
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from '@/components/ui/item'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as PartsSys from '@/systems.client/parts.ts'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import EmojiDisplay from './emoji-display'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Badge } from './ui/badge'
import { buttonVariants } from './ui/button'
import { Label } from './ui/label'

interface FilterEntityCardProps {
	entity: F.FilterEntity
	cfg: LQY.EffectiveColumnAndTableConfig | undefined
}

function FilterEntityCard({ entity, cfg }: FilterEntityCardProps) {
	const rolesRes = useQuery(FilterEntityClient.getAllFilterRoleContributorsBase())
	if (!cfg) return null
	const user = PartsSys.findUser(entity.owner)!
	const onHover = () => {
		FilterEntityClient.filterEditPrefetch(entity.id)
	}
	const roles = rolesRes.data?.filter(role => role.filterId === entity.id)

	return (
		<li key={entity.id}>
			<Item variant="outline" className="h-full transition-none hover:shadow-md hover:border-primary/50" asChild>
				<Link {...FilterEntityClient.filterEditPrefetch(entity.id)} to={AR.link('/filters/:id', entity.id)}>
					{entity.emoji && (
						<ItemMedia>
							<EmojiDisplay emoji={entity.emoji} />
						</ItemMedia>
					)}
					<ItemContent className="self-start">
						<ItemTitle>{entity.name}</ItemTitle>
						<ItemDescription>{entity.description?.split('\n')[0]}</ItemDescription>
					</ItemContent>
					<ItemFooter className="flex items-center gap-4 flex-wrap">
						<div className="flex items-center gap-2">
							<Label className={cn(Typo.Label)}>Owner:</Label>
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
						</div>
						{roles && roles.length > 0 && (
							<div className="flex items-center gap-2">
								<Label className={cn(Typo.Label)}>Contributors:</Label>
								<div className="flex gap-1.5 flex-wrap">
									{roles?.map((role) => (
										<Badge key={role.roleId} variant="secondary" className="flex items-center gap-1.5">
											{role.roleId}
										</Badge>
									))}
								</div>
							</div>
						)}
					</ItemFooter>
				</Link>
			</Item>
		</li>
	)
}

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
				<h2 className={Typo.H2}>Filters</h2>
				<Link className={buttonVariants({ variant: 'secondary' })} to={AR.link('/filters/new')}>
					<Icons.Plus />
					<span>New Filter</span>
				</Link>
			</div>
			<ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{filters.map((entity) => <FilterEntityCard key={entity.id} entity={entity} cfg={cfg} />)}
			</ul>
		</div>
	)
}
