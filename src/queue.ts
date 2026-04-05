import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { loadConfig } from './config';
import type { ChannelName, ChannelJobData } from './types';

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (_connection) return _connection;
  const { redis } = loadConfig();
  _connection = new IORedis({
    host: redis.host,
    port: redis.port,
    maxRetriesPerRequest: null,  // required by BullMQ
    enableReadyCheck: false,
  });
  _connection.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
  });
  return _connection;
}

const queues: Partial<Record<ChannelName, Queue<ChannelJobData>>> = {};

export function getQueue(channel: ChannelName): Queue<ChannelJobData> {
  if (!queues[channel]) {
    queues[channel] = new Queue<ChannelJobData>(`cachewarmer:${channel}`, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queues[channel]!;
}
