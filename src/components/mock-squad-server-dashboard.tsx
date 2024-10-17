import ComboBox from '@/components/combo-box/combo-box.tsx'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import * as DH from '@/lib/display-helpers'
import type { ServerState } from '@/lib/rcon/rcon-squad-mock'
import * as Rcon from '@/lib/rcon/squad-models'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography'
import * as M from '@/models.ts'
import { useForm } from '@tanstack/react-form'
import {
	ColumnDef,
	OnChangeFn,
	PaginationState,
	Row,
	RowSelectionState,
	SortingState,
	VisibilityState,
	createColumnHelper,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table'
import { zodValidator } from '@tanstack/zod-form-adapter'
import React from 'react'

import AddLayerPopover from './add-layer-popover'
import { Alert } from './ui/alert'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'

const MockSquadServerContext = React.createContext<{ refetch: () => void; state?: ServerState }>({ refetch: () => {} })

export default function MockSquadServerDashboard() {
	const serverStateQuery = trpcReact.mockSquadServer.getServerState.useQuery()
	const switchTeamMutation = trpcReact.mockSquadServer.switchTeam.useMutation({
		onSuccess: () => {
			serverStateQuery.refetch()
		},
	})
	const endMatchMutation = trpcReact.mockSquadServer.endMatch.useMutation({
		onSuccess: () => {
			serverStateQuery.refetch()
		},
	})

	async function switchTeam(playerId: number) {
		await switchTeamMutation.mutateAsync(playerId)
	}

	return (
		<MockSquadServerContext.Provider value={{ refetch: serverStateQuery.refetch, state: serverStateQuery.data }}>
			<div className="container mx-auto py-10">
				<h1 className="text-2xl font-bold mb-5">Admin Dashboard</h1>
				<div className="grid grid-cols-2 gap-4">
					<AddPlayerForm />
					<CreateSquadForm />
					<div class="flex space-x-2">
						<SetNextLayerForm />
						<Button onClick={() => endMatchMutation.mutateAsync()}>End Match</Button>
					</div>

					<div>
						<h2 className={Typography.H3}>Server State</h2>
						{serverStateQuery.isLoading || !serverStateQuery.data ? (
							<p>Loading server state...</p>
						) : serverStateQuery.isError ? (
							<p>Error loading server state: {serverStateQuery.error.message}</p>
						) : (
							<div className="space-y-4">
								<div>
									<h3 className={Typography.H4}>Current Map</h3>
									<p>{DH.toShortLayerName(serverStateQuery.data.currentMap)}</p>
									<h3 className={Typography.H4}>Next Map</h3>
									<p>{DH.toShortLayerName(serverStateQuery.data.nextMap)}</p>
								</div>
								<div>
									<h3 className="text-lg font-medium">Players</h3>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>ID</TableHead>
												<TableHead>Name</TableHead>
												<TableHead>Team</TableHead>
												<TableHead>Squad</TableHead>
												<TableHead>Role</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{serverStateQuery.data.players.map((player) => (
												<ContextMenu>
													<ContextMenuTrigger asChild>
														<TableRow key={player.playerID}>
															<TableCell>{player.playerID}</TableCell>
															<TableCell>{player.name}</TableCell>
															<TableCell>{player.teamID}</TableCell>
															<TableCell>{player.squadID}</TableCell>
															<TableCell>{player.role}</TableCell>
														</TableRow>
													</ContextMenuTrigger>
													<ContextMenuContent>
														<ContextMenuItem onClick={() => switchTeam(player.playerID)}>Switch Team</ContextMenuItem>
													</ContextMenuContent>
												</ContextMenu>
											))}
										</TableBody>
									</Table>
								</div>
								<div>
									<h3 className="text-lg font-medium">Squads</h3>
									<ul className="list-disc list-inside">
										{serverStateQuery.data.squads.map((squad) => (
											<li key={squad.squadID}>{squad.squadName}</li>
										))}
									</ul>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</MockSquadServerContext.Provider>
	)
}

function CreateSquadForm() {
	const { refetch, state } = React.useContext(MockSquadServerContext)
	const createSquadMutation = trpcReact.mockSquadServer.createSquad.useMutation({
		onSuccess: () => {
			refetch()
		},
	})

	const form = useForm({
		defaultValues: {
			squadName: '',
			teamID: 0,
			creatorName: undefined as string | undefined,
		},
		validatorAdapter: zodValidator(),
		onSubmit: async ({ value }) => {
			await createSquadMutation.mutateAsync({
				squadName: value.squadName,
				creatorName: value.creatorName,
			})
		},
	})

	function onSubmit(e: React.FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		form.handleSubmit()
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Create Squad</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<form.Field name="squadName" validators={{ onChange: Rcon.SquadSchema.shape.squadName }}>
						{(field) => (
							<div>
								<Label htmlFor={field.name}>Squad Name</Label>
								<Input
									id={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
								/>
								{field.state.meta.errors.length > 0 && <Alert variant="destructive">{field.state.meta.errors.join(', ')}</Alert>}
							</div>
						)}
					</form.Field>

					<form.Field name="creatorName" validators={{ onChange: Rcon.SquadSchema.shape.creatorName }}>
						{(field) => (
							<div>
								<ComboBox
									title="Creator"
									value={field.state.value}
									options={state?.players.map((player) => ({ label: player.name, value: player.name })) ?? []}
									onSelect={(value) => field.handleChange(value)}
									allowEmpty={false}
								/>
							</div>
						)}
					</form.Field>

					<Button type="submit">Create Squad</Button>
				</form>
			</CardContent>
		</Card>
	)
}

function AddPlayerForm() {
	const { refetch } = React.useContext(MockSquadServerContext)
	const connectPlayerMutation = trpcReact.mockSquadServer.connectPlayer.useMutation({
		onSuccess: () => {
			refetch()
		},
	})

	const form = useForm({
		defaultValues: {
			name: '',
			teamID: 0,
			isLeader: false,
			role: '',
			onlineIDs: {},
		},
		validatorAdapter: zodValidator(),
		onSubmit: async ({ value }) => {
			await connectPlayerMutation.mutateAsync({
				isLeader: false,
				name: value.name,
				teamID: value.teamID,
				role: value.role,
				onlineIDs: value.onlineIDs,
				playerID: Math.floor(Math.random() * 1000),
			})
		},
	})

	function onSubmit(e: React.FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		form.handleSubmit()
	}

	return (
		<div>
			<h2 className="text-xl font-semibold mb-3">Connect Player</h2>
			<form onSubmit={onSubmit} className="space-y-4">
				<form.Field name="name" validators={{ onChange: Rcon.PlayerSchema.shape.name }}>
					{(field) => (
						<div>
							<Label htmlFor={field.name}>Name</Label>
							<Input
								id={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
							/>
							{field.state.meta.errors.length > 0 && <Alert variant="destructive">{field.state.meta.errors.join(', ')}</Alert>}
						</div>
					)}
				</form.Field>

				{/* Add more fields for player connection */}

				<Button type="submit">Connect Player</Button>
			</form>
		</div>
	)
}

function SetNextLayerForm() {
	const { refetch } = React.useContext(MockSquadServerContext)
	const setNextLayerMutation = trpcReact.mockSquadServer.setNextLayer.useMutation()

	async function addLayers(layers: M.MiniLayer[]) {
		if (layers.length === 0) return
		await setNextLayerMutation.mutateAsync(layers[0])
		refetch()
	}
	const [addLayerPopoverOpen, setAddLayerPopoverOpen] = React.useState(false)

	return (
		<div>
			<AddLayerPopover addLayers={addLayers} open={addLayerPopoverOpen} onOpenChange={setAddLayerPopoverOpen}>
				<Button>Set Next Layer</Button>
			</AddLayerPopover>
		</div>
	)
}
