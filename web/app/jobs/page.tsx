'use client'

import { useEffect, useState, useCallback, FormEvent } from 'react'
import AppShell from '@/components/AppShell'
import { apiFetch } from '@/lib/api'
import { getSocket } from '@/lib/socket'

interface Job {
  id: string
  queueId: string
  queueName: string
  type: string
  status: string
  priority: number
  runAt: string
  batchId: string | null
  attemptCount: number
  idempotencyKey: string | null
  createdAt: string
}

interface Queue {
  id: string
  name: string
  projectId: string
}

interface Execution {
  id: string
  attemptNumber: number
  status: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
}

interface Log {
  id: string
  level: string
  message: string
  createdAt: string
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-blue-500/20 text-blue-400',
  scheduled: 'bg-purple-500/20 text-purple-400',
  claimed: 'bg-yellow-500/20 text-yellow-500',
  running: 'bg-green-500/20 text-green-400',
  completed: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-red-500/20 text-red-400',
  dead_letter: 'bg-red-900/30 text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [queues, setQueues] = useState<Queue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterQueue, setFilterQueue] = useState('')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [logs, setLogs] = useState<Log[]>([])
  const [showSubmit, setShowSubmit] = useState(false)

  // Submit job form state
  const [submitQueue, setSubmitQueue] = useState('')
  const [submitType, setSubmitType] = useState('echo')
  const [submitPayload, setSubmitPayload] = useState('{}')
  const [submitRunAt, setSubmitRunAt] = useState('')
  const [submitCron, setSubmitCron] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const LIMIT = 20

  const loadQueues = useCallback(async () => {
    try {
      const projects = await apiFetch<{ data: { id: string }[] }>('/projects')
      const allQueues: Queue[] = []
      for (const p of projects.data) {
        const qData = await apiFetch<{ data: Queue[] }>(`/projects/${p.id}/queues?limit=100`)
        allQueues.push(...qData.data)
      }
      setQueues(allQueues)
      if (allQueues.length > 0 && !submitQueue) setSubmitQueue(allQueues[0].id)
    } catch { /* ignore */ }
  }, [submitQueue])

  const loadJobs = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
    if (filterStatus) params.set('status', filterStatus)
    if (filterQueue) params.set('queueId', filterQueue)
    try {
      const data = await apiFetch<{ data: Job[]; meta: { total: number } }>(`/jobs?${params}`)
      setJobs(data.data)
      setTotal(data.meta.total)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [page, filterStatus, filterQueue])

  useEffect(() => { loadQueues() }, [loadQueues])
  useEffect(() => { loadJobs() }, [loadJobs])

  // Live updates via WebSocket
  useEffect(() => {
    const socket = getSocket()
    const handler = () => loadJobs()
    socket.on('job:transition', handler)
    return () => { socket.off('job:transition', handler) }
  }, [loadJobs])

  async function openJobDetail(job: Job) {
    setSelectedJob(job)
    setExecutions([])
    setLogs([])
    try {
      const [exData, logData] = await Promise.all([
        apiFetch<{ data: Execution[] }>(`/jobs/${job.id}/executions`),
        apiFetch<{ data: Log[] }>(`/jobs/${job.id}/logs`),
      ])
      setExecutions(exData.data ?? [])
      setLogs(logData.data ?? [])
    } catch { /* ignore */ }
  }

  async function retryJob(jobId: string) {
    try {
      await apiFetch(`/jobs/${jobId}/retry`, { method: 'POST' })
      await loadJobs()
      if (selectedJob?.id === jobId) setSelectedJob(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to retry job')
    }
  }

  async function cancelJob(jobId: string) {
    try {
      await apiFetch(`/jobs/${jobId}/cancel`, { method: 'POST' })
      await loadJobs()
      if (selectedJob?.id === jobId) setSelectedJob(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job')
    }
  }

  async function submitJob(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      let payload: Record<string, unknown>
      try { payload = JSON.parse(submitPayload) } catch { throw new Error('Payload must be valid JSON') }
      const body: Record<string, unknown> = { type: submitType, payload }
      if (submitRunAt) body.runAt = new Date(submitRunAt).toISOString()
      if (submitCron) body.cronExpression = submitCron
      await apiFetch(`/queues/${submitQueue}/jobs`, { method: 'POST', body: JSON.stringify(body) })
      setShowSubmit(false)
      setSubmitType('echo')
      setSubmitPayload('{}')
      setSubmitRunAt('')
      setSubmitCron('')
      await loadJobs()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit job')
    } finally {
      setSubmitting(false)
    }
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <AppShell>
      <div className="flex flex-col gap-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
            <p className="text-muted-foreground text-sm mt-1">{total} total jobs</p>
          </div>
          <button
            id="submit-job-btn"
            onClick={() => setShowSubmit(true)}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            + Submit Job
          </button>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Submit Job Form */}
        {showSubmit && (
          <div className="rounded-xl border bg-card p-6 shadow">
            <h2 className="font-semibold mb-4">Submit Job</h2>
            <form onSubmit={submitJob} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Queue</label>
                  <select
                    id="submit-job-queue"
                    value={submitQueue}
                    onChange={e => setSubmitQueue(e.target.value)}
                    required
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {queues.map(q => (
                      <option key={q.id} value={q.id}>{q.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Type</label>
                  <input
                    id="submit-job-type"
                    required
                    value={submitType}
                    onChange={e => setSubmitType(e.target.value)}
                    placeholder="e.g. echo, http_request, send_email"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Payload (JSON)</label>
                <textarea
                  id="submit-job-payload"
                  rows={4}
                  value={submitPayload}
                  onChange={e => setSubmitPayload(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Run At <span className="text-muted-foreground">(optional — leave blank for immediate)</span></label>
                  <input
                    id="submit-job-run-at"
                    type="datetime-local"
                    value={submitRunAt}
                    onChange={e => setSubmitRunAt(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Cron Expression <span className="text-muted-foreground">(optional)</span></label>
                  <input
                    id="submit-job-cron"
                    value={submitCron}
                    onChange={e => setSubmitCron(e.target.value)}
                    placeholder="e.g. 0 * * * *"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowSubmit(false)} className="px-4 py-2 rounded-md border text-sm hover:bg-muted">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !submitQueue}
                  id="submit-job-confirm"
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Submit Job'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          <select
            id="filter-status"
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value); setPage(1) }}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            {['queued', 'scheduled', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            id="filter-queue"
            value={filterQueue}
            onChange={e => { setFilterQueue(e.target.value); setPage(1) }}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">All queues</option>
            {queues.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>

          <button
            onClick={() => { setFilterStatus(''); setFilterQueue(''); setPage(1) }}
            className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted text-muted-foreground"
          >
            Clear filters
          </button>
        </div>

        <div className="flex gap-4">
          {/* Jobs table */}
          <div className={`flex-1 rounded-xl border bg-card shadow overflow-hidden ${selectedJob ? 'hidden lg:block' : ''}`}>
            {loading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Loading jobs…</div>
            ) : jobs.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No jobs found.</div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">ID</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Type</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Queue</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Attempts</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {jobs.map(job => (
                      <tr
                        key={job.id}
                        className={`hover:bg-muted/30 transition-colors cursor-pointer ${selectedJob?.id === job.id ? 'bg-muted/50' : ''}`}
                        onClick={() => openJobDetail(job)}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{job.id.slice(0, 8)}…</td>
                        <td className="px-4 py-3 font-medium">{job.type}</td>
                        <td className="px-4 py-3 text-muted-foreground">{job.queueName}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? 'bg-muted text-muted-foreground'}`}>
                            {job.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{job.attemptCount}</td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex gap-2">
                            {(job.status === 'failed' || job.status === 'dead_letter') && (
                              <button
                                id={`retry-job-${job.id}`}
                                onClick={() => retryJob(job.id)}
                                className="px-2 py-0.5 rounded text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                              >
                                Retry
                              </button>
                            )}
                            {(job.status === 'queued' || job.status === 'scheduled') && (
                              <button
                                id={`cancel-job-${job.id}`}
                                onClick={() => cancelJob(job.id)}
                                className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/70"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Pagination */}
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    {Math.min((page - 1) * LIMIT + 1, total)}–{Math.min(page * LIMIT, total)} of {total}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-muted"
                    >← Prev</button>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-muted"
                    >Next →</button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Job detail drawer */}
          {selectedJob && (
            <div className="w-full lg:w-[420px] rounded-xl border bg-card shadow flex-shrink-0">
              <div className="flex items-start justify-between p-4 border-b">
                <div>
                  <h2 className="font-semibold">{selectedJob.type}</h2>
                  <p className="text-xs text-muted-foreground font-mono">{selectedJob.id}</p>
                </div>
                <button onClick={() => setSelectedJob(null)} className="text-muted-foreground hover:text-foreground p-1">✕</button>
              </div>

              <div className="p-4 space-y-4 overflow-y-auto max-h-[600px]">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[selectedJob.status] ?? ''}`}>
                    {selectedJob.status}
                  </span>
                  {(selectedJob.status === 'failed' || selectedJob.status === 'dead_letter') && (
                    <button
                      id="detail-retry-btn"
                      onClick={() => retryJob(selectedJob.id)}
                      className="px-2 py-0.5 rounded text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                    >
                      Retry
                    </button>
                  )}
                  {(selectedJob.status === 'queued' || selectedJob.status === 'scheduled') && (
                    <button
                      id="detail-cancel-btn"
                      onClick={() => cancelJob(selectedJob.id)}
                      className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/70"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                <div className="text-xs space-y-1 text-muted-foreground">
                  <p>Queue: <span className="text-foreground">{selectedJob.queueName}</span></p>
                  <p>Priority: <span className="text-foreground">{selectedJob.priority}</span></p>
                  <p>Attempts: <span className="text-foreground">{selectedJob.attemptCount}</span></p>
                  <p>Run at: <span className="text-foreground">{new Date(selectedJob.runAt).toLocaleString()}</span></p>
                  <p>Created: <span className="text-foreground">{new Date(selectedJob.createdAt).toLocaleString()}</span></p>
                </div>

                {executions.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Executions</h3>
                    <div className="space-y-2">
                      {executions.map(ex => (
                        <div key={ex.id} className="rounded-md border p-2 text-xs space-y-0.5">
                          <div className="flex justify-between">
                            <span>Attempt #{ex.attemptNumber}</span>
                            <span className={STATUS_COLORS[ex.status] ?? ''}>{ex.status}</span>
                          </div>
                          <div className="text-muted-foreground">
                            {new Date(ex.startedAt).toLocaleString()}
                            {ex.durationMs != null && ` · ${ex.durationMs}ms`}
                          </div>
                          {ex.errorMessage && (
                            <div className="text-red-400 break-all">{ex.errorMessage}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {logs.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Logs</h3>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {logs.map(log => (
                        <div key={log.id} className="text-xs font-mono flex gap-2">
                          <span className={`shrink-0 ${log.level === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}>
                            {log.level.toUpperCase()}
                          </span>
                          <span className="break-all">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
