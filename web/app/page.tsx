'use client'

import { useEffect, useState } from 'react'
import { io, Socket } from 'socket.io-client'

interface JobStats {
  queueId: string
  queueName: string
  totalJobs: number
  byStatus: Record<string, number>
  jobsPerMinute: number
}

interface WorkerStats {
  id: string
  hostname: string
  status: string
  activeJobs: number
}

export default function DashboardPage() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [stats, setStats] = useState<JobStats[]>([])
  const [workers, setWorkers] = useState<WorkerStats[]>([])
  const [logs, setLogs] = useState<string[]>([])
  
  useEffect(() => {
    // Connect to Socket.io on the API server
    const s = io(process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000', {
      path: '/socket.io/',
      transports: ['websocket'],
    })
    
    setSocket(s)

    s.on('connect', () => {
      addLog('Connected to Real-time API via WebSocket')
    })

    s.on('job:update', (data) => {
      addLog(`Job Update: [${data.status}] Job ${data.jobId} in queue ${data.queueId}`)
    })

    s.on('worker:update', (data) => {
      addLog(`Worker Update: Worker ${data.workerId} heartbeat (Jobs: ${data.activeJobCount})`)
    })

    return () => {
      s.disconnect()
    }
  }, [])

  const addLog = (msg: string) => {
    setLogs((prev) => [msg, ...prev].slice(0, 10))
  }

  // A quick stub for demonstration. In a real app we would fetch the initial state via REST.
  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Chronos Overview</h1>
        <p className="text-muted-foreground">Monitor your distributed queues and worker nodes in real-time.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Simple stat cards mimicking shadcn UI */}
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Total Queues</h3>
          </div>
          <div className="p-6 pt-0">
            <div className="text-2xl font-bold">3</div>
          </div>
        </div>
        
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Active Workers</h3>
          </div>
          <div className="p-6 pt-0">
            <div className="text-2xl font-bold text-green-500">2</div>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Throughput</h3>
          </div>
          <div className="p-6 pt-0">
            <div className="text-2xl font-bold">140 / min</div>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">Failed Jobs</h3>
          </div>
          <div className="p-6 pt-0">
            <div className="text-2xl font-bold text-destructive">12</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <div className="col-span-4 rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-col space-y-1.5">
            <h3 className="font-semibold leading-none tracking-tight">Real-time Event Stream</h3>
            <p className="text-sm text-muted-foreground">Live updates from Redis Pub/Sub.</p>
          </div>
          <div className="p-6 pt-0">
            <div className="space-y-4">
              {logs.length === 0 && <div className="text-sm text-muted-foreground">Waiting for events...</div>}
              {logs.map((log, i) => (
                <div key={i} className="text-sm font-mono p-2 bg-muted rounded">
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>
        
        <div className="col-span-3 rounded-xl border bg-card text-card-foreground shadow">
          <div className="p-6 flex flex-col space-y-1.5">
            <h3 className="font-semibold leading-none tracking-tight">Active Queues</h3>
          </div>
          <div className="p-6 pt-0">
             <div className="space-y-4">
                {/* Mock Queue List */}
                <div className="flex items-center">
                  <div className="ml-4 space-y-1">
                    <p className="text-sm font-medium leading-none">Email Notifications</p>
                    <p className="text-sm text-muted-foreground">High Priority</p>
                  </div>
                  <div className="ml-auto font-medium text-sm">42 Queued</div>
                </div>
                <div className="flex items-center">
                  <div className="ml-4 space-y-1">
                    <p className="text-sm font-medium leading-none">Image Processing</p>
                    <p className="text-sm text-muted-foreground">Default Priority</p>
                  </div>
                  <div className="ml-auto font-medium text-sm">0 Queued</div>
                </div>
             </div>
          </div>
        </div>
      </div>
    </div>
  )
}
