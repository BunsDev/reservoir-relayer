import _ from "lodash";

import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { redis, releaseLock } from "../../common/redis";
import { config } from "../../config";
import { fetchOrdersByPageToken } from "./utils";
import { logger } from "../../common/logger";

const REALTIME_QUEUE_NAME = "realtime-coinbase-sync";

export const realtimeQueue = new Queue(REALTIME_QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 1,
    backoff: {
      type: "fixed",
      delay: 3,
    },
    timeout: 60000,
    removeOnComplete: 10000,
    removeOnFail: 100,
  },
});
new QueueScheduler(REALTIME_QUEUE_NAME, { connection: redis.duplicate() });

if (config.doRealtimeWork) {
  const realtimeWorker = new Worker(
    REALTIME_QUEUE_NAME,
    async (job: Job) => {
      try {
        const cacheKey = "coinbase-sync-last";
        let pageTokenCache = await redis.get(cacheKey);

        if (_.isNull(pageTokenCache)) {
          pageTokenCache = "";
        }

        logger.info(
          REALTIME_QUEUE_NAME,
          `Start Coinbase sync from pageTokenCache=${pageTokenCache}`
        );
        const [newPageToken] = await fetchOrdersByPageToken("sell", pageTokenCache);

        if (newPageToken == pageTokenCache) {
          logger.info(
            REALTIME_QUEUE_NAME,
            `Coinbase pageToken didn't change pageToken=${pageTokenCache}, newPageToken=${newPageToken}`
          );
        }

        // Set the new pageToken for the next job
        if (newPageToken) {
          await redis.set(cacheKey, newPageToken);
        }
      } catch (error) {
        logger.error(
          REALTIME_QUEUE_NAME,
          JSON.stringify({
            message: `Coinbase sync failed attempts=${job.attemptsMade}, error=${error}`,
            error,
            attempts: job.attemptsMade,
            syncSource: "Coinbase",
          })
        );
      }
    },
    { connection: redis.duplicate(), concurrency: 2 }
  );

  realtimeWorker.on("completed", async (job) => {
    // Release the lock to allow the next sync
    await releaseLock("coinbase-sync-lock", false);

    if (job.attemptsMade > 0) {
      logger.info(REALTIME_QUEUE_NAME, `Sync recover attempts=${job.attemptsMade}`);
    }
  });

  realtimeWorker.on("error", (error) => {
    logger.error(REALTIME_QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToRealtimeQueue = async (delayMs: number = 0) => {
  await realtimeQueue.add(REALTIME_QUEUE_NAME, {}, { delay: delayMs });
};
