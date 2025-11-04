import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/testroute')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/testroute"!</div>
}
