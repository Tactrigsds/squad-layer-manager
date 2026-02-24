import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as Discord from '@/systems/discord.server'
import * as Fastify from '@/systems/fastify.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sessions from '@/systems/sessions.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as superjson from 'superjson'

const w = global as any
w.Discord = Discord
w.Fastify = Fastify
w.LayerQueue = LayerQueue
w.MatchHistory = MatchHistory
w.Rbac = Rbac
w.Sessions = Sessions
w.SquadServer = SquadServer
w.superjson = superjson
w.Battlemetrics = Battlemetrics

w.debug__setTicketOutcome = (team1: number, team2: number) => {
	SquadServer.globalState.debug__ticketOutcome = { team1, team2 }
}
console.log('-------- DEVELOPER CONSOLE LOADED --------')
