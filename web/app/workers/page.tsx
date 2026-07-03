'use client'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import { apiFetch } from '@/lib/api'
import { getSocket } from '@/lib/socket'

interface Worker {
  id: string
  hostname: string
  pid: number
  status: string
  startedAt: string
  lastHeartbeatAt: string
  activeJobCount: number
  cpuLoad: number | null
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400',
  draining: 'bg-yellow-500/20 text-yellow-500',
  dead: 'bg-red-500/20 text-red-400',
}

function timeSince(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export default function WorkersPage() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [now, setNow] = useState(Date.now())

  const loadWorkers = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ limit: '100' })
    if (filterStatus) params.set('status', filterStatus)
    try {
      const data = await apiFetch<{ data: Worker[] }>(`/workers?${params}`)
      setWorkers(data.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load workers')
    } finally {
      setLoading(false)
    }
  }, [filterStatus])

  useEffect(() => {
    loadWorkers()
    const refreshInterval = setInterval(loadWorkers, 30_000)
    // Tick the "time since" clock every second
    const clockInterval = setInterval(() => setNow(Date.now()), 1_000)

    // Real-time updates via WebSocket
    const socket = getSocket()
    const onHeartbeat = (data: { workerId: string; activeJobCount: number; cpuLoad?: number }) => {
      setWorkers(prev => prev.map(w =>
        w.id === data.workerId
          ? { ...w, activeJobCount: data.activeJobCount, cpuLoad: data.cpuLoad ?? w.cpuLoad, lastHeartbeatAt: new Date().toISOString() }
          : w
      ))
    }
    socket.on('worker:heartbeat', onHeartbeat)

    return () => {
      clearInterval(refreshInterval)
      clearInterval(clockInterval)
      socket.off('worker:heartbeat', onHeartbeat)
    }
  }, [loadWorkers])

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Workers</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {workers.filter(w => w.status === 'active').length} active
              {' / '}
              {workers.length} total — live heartbeat updates via WebSocket
            </p>
          </div>
          <button
            onClick={loadWorkers}
            className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted text-muted-foreground"
          >
            ↻ Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <select
            id="filter-worker-status"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draining">Draining</option>
            <option value="dead">Dead</option>
          </select>
        </div>

        <div className="rounded-xl border bg-card shadow overflow-hidden">
          {loading && workers.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading workers…</div>
          ) : workers.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No workers found. Workers register automatically when the worker service starts.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Hostname</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">PID</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active Jobs</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">CPU Load</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Last Heartbeat</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {workers.map(w => {
                  const heartbeatAge = (now - new Date(w.lastHeartbeatAt).getTime()) / 1000
                  const stale = heartbeatAge > 60
                  return (
                    <tr key={w.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{w.hostname}</td>
                      <td className="px-4 py-3 text-muted-foreground font-mono">{w.pid}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[w.status] ?? 'bg-muted text-muted-foreground'}`}>
                          {w.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={w.activeJobCount > 0 ? 'text-green-400 font-medium' : 'text-muted-foreground'}>
                          {w.activeJobCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {w.cpuLoad != null ? w.cpuLoad.toFixed(2) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={stale ? 'text-yellow-500' : 'text-muted-foreground'} title={w.lastHeartbeatAt}>
                          {timeSince(w.lastHeartbeatAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {new Date(w.startedAt).toLocaleString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  )
}
