import { trpc } from '@/lib/trpc'
import { GridIcon } from '@radix-ui/react-icons'

export default function AppContainer(props: { children: React.ReactNode }) {
	const serverInfoRes = trpc.getServerInfo.useQuery()
	return (
		<div>
			<nav className="flex items-center justify-between">
				<div className="flex items-start">
					<GridIcon />
				</div>
				<div className=""></div>
			</nav>
			{props.children}
		</div>
	)
}
