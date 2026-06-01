import Queue from 'bull';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let lastQueueErrorLogAt = 0;

function redisTargetLabel(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'rediss:' ? '6379' : '6379')}`;
  } catch {
    return 'invalid-redis-url';
  }
}

function createRedisClient() {
  return new Redis(redisUrl, {
    // Avoid hard-failing commands at the default 20 retries during transient Redis issues.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// Create queue
export const scrapeQueue = new Queue('airbnb-scrape', redisUrl, {
  createClient: () => createRedisClient(),
  defaultJobOptions: {
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200,     // Keep last 200 failed jobs
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  }
});

// Add search job to queue
// Uses a deterministic jobId (search-{alertId}) so Bull automatically deduplicates:
// if a job for the same alert is already waiting/active, it won't add another.
export async function addSearchJob(alertId, priority = 'normal') {
  const priorityMap = { low: 10, normal: 5, high: 1 };
  const jobId = `search-${alertId}`;

  // Check if a job with this ID is already waiting or active
  const existing = await scrapeQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return existing; // already queued, skip duplicate
    }
  }

  return await scrapeQueue.add(
    'search',
    { alertId, type: 'search' },
    { jobId, priority: priorityMap[priority] || 5 }
  );
}

// Add listing monitoring job
export async function addListingJob(alertId, priority = 'normal') {
  const priorityMap = { low: 10, normal: 5, high: 1 };
  const jobId = `listing-${alertId}`;

  const existing = await scrapeQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return existing;
    }
  }

  return await scrapeQueue.add(
    'listing',
    { alertId, type: 'listing' },
    { jobId, priority: priorityMap[priority] || 5 }
  );
}

// Monitor queue events
scrapeQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completed:`, result);
});

scrapeQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

scrapeQueue.on('stalled', (job) => {
  console.warn(`⚠️  Job ${job.id} stalled`);
});

scrapeQueue.on('error', (err) => {
  const now = Date.now();
  // Avoid flooding logs on reconnect loops; keep one detailed line every 10s.
  if (now - lastQueueErrorLogAt < 10_000) return;
  lastQueueErrorLogAt = now;
  const code = err?.code ? ` code=${err.code}` : '';
  const name = err?.name ? ` name=${err.name}` : '';
  const msg = err?.message || 'unknown error';
  console.error(`❌ Queue connection error to ${redisTargetLabel(redisUrl)}:${code}${name} ${msg}`);
});

export default scrapeQueue;
