export default function TabsList<T extends string>(props: {
	options: { value: T; label: string; disabled?: boolean }[]
	active: T
	setActive: (active: T) => void
}) {
	return (
		<div className='inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground'>
			{props.options.map((option) => (
				<button
					key={option.value}
					disabled={option.disabled}
					type='button'
					data-state={props.active === option.value && 'active'}
					onClick={() => {
						props.setActive(option.value)
					}}
					className='inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow'
				>
					{option.label}
				</button>
			))}
		</div>
	)
}
