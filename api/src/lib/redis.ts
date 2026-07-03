import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Primary client for commands
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: true,
})

// Separate client for pub/sub subscriptions (cannot issue regular commands while subscribed)
export const redisSub = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: true,
})

redis.on('error', (err) => console.error('[Redis] Connection error:', err.message))
redisSub.on('error', (err) => console.error('[Redis Sub] Connection error:', err.message))
