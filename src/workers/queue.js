import Queue from 'bull';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

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
export async function addSearchJob(alertId, priority = 'normal') {
  const priorityMap = { low: 10, normal: 5, high: 1 };
  
  return await scrapeQueue.add(
    'search',
    { alertId, type: 'search' },
    { priority: priorityMap[priority] || 5 }
  );
}

// Add listing monitoring job
export async function addListingJob(alertId, priority = 'normal') {
  const priorityMap = { low: 10, normal: 5, high: 1 };
  
  return await scrapeQueue.add(
    'listing',
    { alertId, type: 'listing' },
    { priority: priorityMap[priority] || 5 }
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
  console.error('❌ Queue connection error:', err.message);
});

export default scrapeQueue;
