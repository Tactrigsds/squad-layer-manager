import { trpc } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import { useMutation, useQuery } from '@tanstack/react-query'
import React from 'react'

export function useStartVote() {
	return useMutation({
		mutationFn: trpc.layerQueue.startVote.mutate,
	})
}

export function useAbortVote() {
	return useMutation({
		mutationFn: trpc.layerQueue.abortVote.mutate,
	})
}
