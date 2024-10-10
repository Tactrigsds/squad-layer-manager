import * as AR from '@/app-routes.ts'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import { Link } from 'react-router-dom'

import { Button, buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const filtersData = trpcReact.getFilters.useQuery()
	return (
		<div className="w-full mt-4">
			<div className="flex flex-col space-y-2 w-[500px] mx-auto">
				<div>
					<Link className={buttonVariants()} to={AR.link('/filters/new')}>
						New Filter
					</Link>
				</div>
				{filtersData.data?.map((filter) => (
					<div key={filter.id} className="flex w-full">
						<Link className={cn('flex-grow', buttonVariants({ variant: 'outline' }))} to={AR.link('/filters/:id/edit', filter.id)}>
							{filter.name}
						</Link>
					</div>
				))}
			</div>
		</div>
	)
}
