// src/socket/index.ts
// Socket.io server with Redis pub/sub adapter for real-time job state events.
//
// Rooms:
//   queue:{queueId}      — clients subscribe to a specific queue's job events
//   project:{projectId}  — clients subscribe to all events in a project
//
// Redis channels:
//   job:transitions      — job status changes, created, cancelled, retried events
//   worker:heartbeat     — worker status and heartbeat events

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { redisSub } from '../lib/redis';
import { JobTransitionEvent, WorkerHeartbeatEvent } from '../types';

export interface ChronosSocketServer {
  io: SocketServer;
  shutdown: () => Promise<void>;
}

export function createSocketServer(httpServer: HttpServer): ChronosSocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:3000'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    console.info(`[socket] client connected: ${socket.id}`);

    // Client joins a queue room
    socket.on('subscribe:queue', (queueId: string) => {
      if (typeof queueId !== 'string' || !queueId) return;
      const room = `queue:${queueId}`;
      socket.join(room);
      socket.emit('subscribed', { room });
      console.info(`[socket] ${socket.id} joined ${room}`);
    });

    // Client joins a project room
    socket.on('subscribe:project', (projectId: string) => {
      if (typeof projectId !== 'string' || !projectId) return;
      const room = `project:${projectId}`;
      socket.join(room);
      socket.emit('subscribed', { room });
      console.info(`[socket] ${socket.id} joined ${room}`);
    });

    // Client leaves a queue room
    socket.on('unsubscribe:queue', (queueId: string) => {
      socket.leave(`queue:${queueId}`);
    });

    // Client leaves a project room
    socket.on('unsubscribe:project', (projectId: string) => {
      socket.leave(`project:${projectId}`);
    });

    socket.on('disconnect', (reason) => {
      console.info(`[socket] client disconnected: ${socket.id} reason=${reason}`);
    });

    socket.on('error', (err: Error) => {
      console.error(`[socket] error on ${socket.id}:`, err.message);
    });
  });

  // ── Redis subscriber: job transitions ──────────────────────────────────────
  redisSub.subscribe('job:transitions', (err) => {
    if (err) {
      console.error('[redis:sub] failed to subscribe to job:transitions:', err.message);
    } else {
      console.info('[redis:sub] subscribed to job:transitions');
    }
  });

  // ── Redis subscriber: worker heartbeats ───────────────────────────────────
  redisSub.subscribe('worker:heartbeat', (err) => {
    if (err) {
      console.error('[redis:sub] failed to subscribe to worker:heartbeat:', err.message);
    } else {
      console.info('[redis:sub] subscribed to worker:heartbeat');
    }
  });

  // ── Message dispatch ───────────────────────────────────────────────────────
  redisSub.on('message', (channel: string, message: string) => {
    try {
      const data = JSON.parse(message) as Record<string, unknown>;

      if (channel === 'job:transitions') {
        const event = data as JobTransitionEvent & { type?: string };

        // Emit to queue room
        if (event.queueId) {
          io.to(`queue:${event.queueId}`).emit('job:update', event);
        }

        // Emit to project room
        if (event.projectId) {
          io.to(`project:${event.projectId}`).emit('job:update', event);
        }
      } else if (channel === 'worker:heartbeat') {
        const event = data as WorkerHeartbeatEvent;

        // Broadcast worker updates to all connected clients
        io.emit('worker:update', event);
      }
    } catch (err) {
      console.error(`[socket] failed to parse Redis message on ${channel}:`, err);
    }
  });

  // ── Shutdown ───────────────────────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    return new Promise((resolve) => {
      io.close(() => {
        console.info('[socket] server closed');
        resolve();
      });
    });
  }

  return { io, shutdown };
}

export default createSocketServer;
