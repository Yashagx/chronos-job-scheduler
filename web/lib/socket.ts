/**
 * lib/socket.ts
 * Singleton socket.io-client connection.
 * Connects to the same origin — Nginx proxies /socket.io/ to the API container.
 * For local dev set NEXT_PUBLIC_WS_URL=http://localhost:4000
 */

import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    // In production: same origin (Nginx proxies /socket.io/ to api:4000)
    // In dev: NEXT_PUBLIC_WS_URL=http://localhost:4000
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? (typeof window !== 'undefined' ? window.location.origin : '')
    socket = io(wsUrl, {
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      autoConnect: true,
    })
  }
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
