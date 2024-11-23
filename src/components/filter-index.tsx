import { Link } from 'react-router-dom'

import * as AR from '@/app-routes.ts'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'

import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const filtersData = trpcReact.filters.getFilters.useQuery()
	return (
		<div className="mt-4 w-full">
			<div className="mx-auto flex w-[500px] flex-col space-y-2">
				<div>
					<Link className={buttonVariants()} to={AR.link('/filters/new', [])}>
						New Filter
					</Link>
				</div>
				{filtersData.data?.map((filter) => (
					<div key={filter.id} className="w-full">
						<Link
							className={cn('flex w-full flex-grow items-center justify-between space-x-4', buttonVariants({ variant: 'outline' }))}
							to={AR.link('/filters/:id/edit', [filter.id])}
						>
							<span>{filter.name}</span>
							{filter.description && (
								<>
									<span>{' - '}</span>
									<span className={Typography.Muted}>{filter.description}</span>
								</>
							)}
						</Link>
					</div>
				))}
			</div>
		</div>
	)
}
