'use client'

import { useEffect, useState, useCallback, FormEvent } from 'react'
import AppShell from '@/components/AppShell'
import { apiFetch } from '@/lib/api'

interface Queue {
  id: string
  projectId: string
  name: string
  priority: number
  concurrencyLimit: number
  isPaused: boolean
  totalJobs: number
  jobsByStatus: Record<string, number>
  createdAt: string
}

interface Project {
  id: string
  name: string
  orgId: string
}

export default function QueuesPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [queues, setQueues] = useState<Queue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showNewQueue, setShowNewQueue] = useState(false)
  const [newQueueName, setNewQueueName] = useState('')
  const [newQueueConcurrency, setNewQueueConcurrency] = useState('10')
  const [newQueuePriority, setNewQueuePriority] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  const [editingConcurrency, setEditingConcurrency] = useState<Record<string, string>>({})

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiFetch<{ data: Project[] }>('/projects')
      setProjects(data.data)
      if (data.data.length > 0 && !selectedProject) {
        setSelectedProject(data.data[0].id)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load projects')
    }
  }, [selectedProject])

  const loadQueues = useCallback(async () => {
    if (!selectedProject) return
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<{ data: Queue[] }>(`/projects/${selectedProject}/queues?limit=100`)
      setQueues(data.data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load queues')
    } finally {
      setLoading(false)
    }
  }, [selectedProject])

  useEffect(() => { loadProjects() }, [loadProjects])
  useEffect(() => { loadQueues() }, [loadQueues])

  async function togglePause(q: Queue) {
    try {
      await apiFetch(`/queues/${q.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPaused: !q.isPaused }),
      })
      await loadQueues()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update queue')
    }
  }

  async function saveConcurrency(q: Queue) {
    const val = parseInt(editingConcurrency[q.id] ?? String(q.concurrencyLimit))
    if (isNaN(val) || val < 1) return
    try {
      await apiFetch(`/queues/${q.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ concurrencyLimit: val }),
      })
      setEditingConcurrency(prev => { const n = { ...prev }; delete n[q.id]; return n })
      await loadQueues()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update concurrency')
    }
  }

  async function createQueue(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await apiFetch(`/projects/${selectedProject}/queues`, {
        method: 'POST',
        body: JSON.stringify({
          name: newQueueName,
          concurrencyLimit: parseInt(newQueueConcurrency) || 10,
          priority: parseInt(newQueuePriority) || 0,
        }),
      })
      setShowNewQueue(false)
      setNewQueueName('')
      setNewQueueConcurrency('10')
      setNewQueuePriority('0')
      await loadQueues()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create queue')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Queues</h1>
            <p className="text-muted-foreground text-sm mt-1">Manage job queues across your projects</p>
          </div>
          <button
            id="new-queue-btn"
            onClick={() => setShowNewQueue(true)}
            disabled={!selectedProject}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            + New Queue
          </button>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Project selector */}
        {projects.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Project:</label>
            <select
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* New Queue Form */}
        {showNewQueue && (
          <div className="rounded-xl border bg-card p-6 shadow">
            <h2 className="font-semibold mb-4">Create New Queue</h2>
            <form onSubmit={createQueue} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Name</label>
                  <input
                    id="new-queue-name"
                    required
                    value={newQueueName}
                    onChange={e => setNewQueueName(e.target.value)}
                    placeholder="e.g. email-jobs"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Concurrency limit</label>
                  <input
                    id="new-queue-concurrency"
                    type="number" min="1" max="1000"
                    value={newQueueConcurrency}
                    onChange={e => setNewQueueConcurrency(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Priority (0-100)</label>
                  <input
                    id="new-queue-priority"
                    type="number" min="0" max="100"
                    value={newQueuePriority}
                    onChange={e => setNewQueuePriority(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowNewQueue(false)} className="px-4 py-2 rounded-md border text-sm hover:bg-muted">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  id="create-queue-submit"
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {submitting ? 'Creating…' : 'Create Queue'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Queues table */}
        <div className="rounded-xl border bg-card shadow overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading queues…</div>
          ) : queues.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No queues yet. {selectedProject ? 'Create one above.' : 'Select a project first.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Concurrency</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Jobs</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Queued/Running</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pause</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {queues.map(q => (
                  <tr key={q.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium">{q.name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        q.isPaused ? 'bg-yellow-500/20 text-yellow-500' : 'bg-green-500/20 text-green-500'
                      }`}>
                        {q.isPaused ? 'Paused' : 'Active'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {editingConcurrency[q.id] !== undefined ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number" min="1" max="1000"
                            value={editingConcurrency[q.id]}
                            onChange={e => setEditingConcurrency(prev => ({ ...prev, [q.id]: e.target.value }))}
                            className="w-16 rounded border bg-background px-2 py-1 text-xs"
                          />
                          <button onClick={() => saveConcurrency(q)} className="text-xs text-primary hover:underline">Save</button>
                          <button
                            onClick={() => setEditingConcurrency(prev => { const n = { ...prev }; delete n[q.id]; return n })}
                            className="text-xs text-muted-foreground hover:underline"
                          >Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditingConcurrency(prev => ({ ...prev, [q.id]: String(q.concurrencyLimit) }))}
                          className="hover:underline text-left"
                          title="Click to edit"
                        >
                          {q.concurrencyLimit}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{q.totalJobs}</td>
                    <td className="px-4 py-3">
                      <span className="text-blue-400">{q.jobsByStatus?.queued ?? 0}</span>
                      {' / '}
                      <span className="text-green-400">{(q.jobsByStatus?.claimed ?? 0) + (q.jobsByStatus?.running ?? 0)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        id={`toggle-pause-${q.id}`}
                        onClick={() => togglePause(q)}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                          q.isPaused
                            ? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
                            : 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30'
                        }`}
                      >
                        {q.isPaused ? 'Resume' : 'Pause'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  )
}
