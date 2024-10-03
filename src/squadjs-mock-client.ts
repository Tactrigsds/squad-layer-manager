import { io } from 'socket.io-client'

const socket = io('ws://localhost:3000', {
	reconnectionDelayMax: 10000,
	// auth: {
	//   token: "123"
	// },
	query: {
		'my-key': 'my-value',
	},
})

socket.on('connect', () => {
	console.log('connected')
	socket.emit('command', { comand: 'vote', args: ['1'], playerId: '<steamId>' })
})
socket.on('message', (message) => {
	console.log('msg', message)
})

socket.on('error', (error) => {
	console.error('error', error)
})

socket.on('connect_error', (error) => {
	console.log('connect_error', error)
})
