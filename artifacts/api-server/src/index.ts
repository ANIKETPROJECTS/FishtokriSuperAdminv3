import app from "./app.js";
import { logger } from "./lib/logger.js";
import { connectDB } from "./db/index.js";
import { runInventoryBackgroundDeduction } from "./routes/inventory.js";
import { syncAllTimeslotOrderLimits } from "./routes/orders.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

connectDB()
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");

      // Run once at startup (after 5s) to sync timeslot order limits that may
      // have drifted while the server was down.
      setTimeout(() => {
        syncAllTimeslotOrderLimits().catch((e) =>
          logger.error({ err: e }, "bg timeslot sync (startup) failed")
        );
      }, 5_000);

      // Run once at startup (after 15s) to catch any orders that missed deduction
      // while the server was down, then keep polling every 60s.
      setTimeout(() => {
        runInventoryBackgroundDeduction().catch((e) =>
          logger.error({ err: e }, "bg inventory deduction (startup) failed")
        );
      }, 15_000);

      setInterval(() => {
        runInventoryBackgroundDeduction().catch((e) =>
          logger.error({ err: e }, "bg inventory deduction (poll) failed")
        );
      }, 60_000);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to connect to MongoDB");
    process.exit(1);
  });
