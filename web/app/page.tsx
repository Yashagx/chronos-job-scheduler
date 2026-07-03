'use client'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import { apiFetch } from '@/lib/api'
import { getSocket } from '@/lib/socket'

interface Summary {
  totalQueues: number
  activeWorkers: number
  totalWorkers: number
  failedJobs: number
  queuedJobs: number
  runningJobs: number
  completedJobsToday: number
  jobsPerMinute: number
}

interface Event {
  id: string
  text: string
  ts: string
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="p-6 pb-2">
        <h3 className="tracking-tight text-sm font-medium text-muted-foreground">{label}</h3>
      </div>
      <div className="p-6 pt-0">
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [connected, setConnected] = useState(false)

  const addEvent = useCallback((text: string) => {
    const id = `${Date.now()}-${Math.random()}`
    const ts = new Date().toLocaleTimeString()
    setEvents(prev => [{ id, text, ts }, ...prev].slice(0, 30))
  }, [])

  const loadSummary = useCallback(async () => {
    try {
      const data = await apiFetch<Summary>('/dashboard/summary')
      setSummary(data)
    } catch {
      // Silently fail on summary fetch — page will show stale data
    }
  }, [])

  useEffect(() => {
    loadSummary()
    const interval = setInterval(loadSummary, 15_000)

    const socket = getSocket()

    const onConnect = () => {
      setConnected(true)
      addEvent('Connected to real-time event stream')
    }
    const onDisconnect = () => {
      setConnected(false)
      addEvent('Disconnected — reconnecting…')
    }
    const onJobTransition = (data: { jobId: string; status: string; queueId: string }) => {
      addEvent(`Job ${data.jobId.slice(0, 8)}… → ${data.status} (queue: ${data.queueId.slice(0, 8)}…)`)
      loadSummary()
    }
    const onWorkerHeartbeat = (data: { workerId: string; activeJobCount: number }) => {
      addEvent(`Worker ${data.workerId.slice(0, 8)}… heartbeat — ${data.activeJobCount} active jobs`)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('job:transition', onJobTransition)
    socket.on('worker:heartbeat', onWorkerHeartbeat)

    if (socket.connected) setConnected(true)

    return () => {
      clearInterval(interval)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('job:transition', onJobTransition)
      socket.off('worker:heartbeat', onWorkerHeartbeat)
    }
  }, [addEvent, loadSummary])

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-6xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">System overview — refreshes every 15 seconds</p>
        </div>

        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Queues" value={summary?.totalQueues ?? '—'} />
          <StatCard
            label="Active Workers"
            value={summary ? `${summary.activeWorkers} / ${summary.totalWorkers}` : '—'}
          />
          <StatCard
            label="Jobs / min"
            value={summary?.jobsPerMinute ?? '—'}
            sub={`${summary?.queuedJobs ?? '—'} queued · ${summary?.runningJobs ?? '—'} running`}
          />
          <StatCard
            label="Failed Jobs"
            value={summary?.failedJobs ?? '—'}
            sub={`${summary?.completedJobsToday ?? '—'} completed today`}
          />
        </div>

        {/* Event stream */}
        <div className="rounded-xl border bg-card shadow">
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div>
              <h2 className="font-semibold">Real-time Event Stream</h2>
              <p className="text-xs text-muted-foreground">Live job transitions and worker heartbeats via WebSocket</p>
            </div>
            <div className={`flex items-center gap-1.5 text-xs font-medium ${connected ? 'text-green-500' : 'text-muted-foreground'}`}>
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground'}`} />
              {connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <div className="p-4 space-y-1.5 min-h-[200px] max-h-[400px] overflow-y-auto">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">Waiting for events…</p>
            ) : (
              events.map(e => (
                <div key={e.id} className="flex items-start gap-3 text-sm font-mono">
                  <span className="text-muted-foreground shrink-0 text-xs pt-0.5">{e.ts}</span>
                  <span>{e.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
