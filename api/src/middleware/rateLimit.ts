// src/middleware/rateLimit.ts
// Redis token-bucket rate limiter middleware.
//
// Each bucket has:
//   key       : `ratelimit:{userId}:{endpoint}`
//   tokens    : current token count
//   lastRefill: unix timestamp of last refill
//
// On each request:
//   1. Load bucket state from Redis (HGETALL)
//   2. Compute tokens to add since lastRefill (rate * elapsed / window)
//   3. If tokens >= 1, consume 1 and allow. Otherwise throw RateLimitError.
//   4. Persist updated bucket (HSET + EXPIRE)

import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../lib/redis';
import { RateLimitError } from '../lib/errors';

export interface RateLimitConfig {
  /** Maximum requests per window */
  maxTokens: number;
  /** Window duration in seconds */
  windowSecs: number;
}

// Preset configs
export const JOB_SUBMISSION_LIMIT: RateLimitConfig = { maxTokens: 100, windowSecs: 60 };
export const AUTH_LIMIT: RateLimitConfig = { maxTokens: 10, windowSecs: 60 };

/**
 * Returns a Fastify preHandler that applies a token-bucket rate limit.
 *
 * @param endpoint  Short label for this endpoint group (used as part of Redis key)
 * @param config    Rate limit config (maxTokens per windowSecs)
 */
export function rateLimit(endpoint: string, config: RateLimitConfig) {
  const { maxTokens, windowSecs } = config;

  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Use userId when authenticated, otherwise fall back to IP
    const identity =
      (request.user?.sub) ?? request.ip ?? 'anonymous';

    const key = `ratelimit:${identity}:${endpoint}`;
    const now = Date.now() / 1000; // seconds

    // Lua script for atomic token-bucket check+update
    const luaScript = `
      local key       = KEYS[1]
      local now       = tonumber(ARGV[1])
      local maxTok    = tonumber(ARGV[2])
      local windowSec = tonumber(ARGV[3])

      local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
      local tokens    = tonumber(bucket[1]) or maxTok
      local lastRefill = tonumber(bucket[2]) or now

      -- Refill tokens proportionally to elapsed time
      local elapsed = now - lastRefill
      local refill  = (elapsed / windowSec) * maxTok
      tokens = math.min(maxTok, tokens + refill)

      if tokens < 1 then
        -- Not enough tokens — return time until next token available
        local waitFrac = (1 - tokens) / (maxTok / windowSec)
        redis.call('HSET', key, 'tokens', tokens, 'lastRefill', now)
        redis.call('EXPIRE', key, windowSec * 2)
        return {0, math.ceil(waitFrac)}
      end

      -- Consume one token
      tokens = tokens - 1
      redis.call('HSET', key, 'tokens', tokens, 'lastRefill', now)
      redis.call('EXPIRE', key, windowSec * 2)
      return {1, 0}
    `;

    type LuaResult = [number, number];
    const result = await (redis as unknown as {
      eval(script: string, numkeys: number, ...args: string[]): Promise<LuaResult>;
    }).eval(luaScript, 1, key, String(now), String(maxTokens), String(windowSecs)) as LuaResult;

    const allowed = result[0] === 1;
    const retryAfter = result[1] as number;

    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
      reply.header('X-RateLimit-Limit', String(maxTokens));
      reply.header('X-RateLimit-Remaining', '0');
      reply.header('X-RateLimit-Reset', String(Math.ceil(now + retryAfter)));
      throw new RateLimitError(retryAfter);
    }

    // Set informational headers on allowed requests
    reply.header('X-RateLimit-Limit', String(maxTokens));
  };
}

export default rateLimit;
