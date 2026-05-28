import "dotenv/config";
// Polyfill globalThis.crypto for Node.js 18 (required by jose JWT library)
import { webcrypto } from "crypto";
if (!globalThis.crypto) (globalThis as unknown as Record<string, unknown>).crypto = webcrypto;

import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerScimRoutes } from "../scimHttp";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runDailyVerificationMaintenance, advanceRunningVerificationJobs } from "../routers/emailVerification";
import { processEnrollments } from "../sequenceEngine";
import { autoSendForAllWorkspaces } from "../routers/sequences";
import { runNightlyBatch } from "../nightlyBatch";
import { runAreEngine } from "../areEngine";
import { runPipelineAlertsCron } from "../routers/pipelineAlerts";
import { runSegmentEnrollmentForAllWorkspaces } from "../routers/segmentRules"; // eslint-disable-line
import { registerEmailTrackingRoutes } from "../emailTracking";
import { startInboundReplyPoller } from "../inboundReplyPoller";
import { expireInvitations, sendExpiryWarningEmails } from "../inviteExpiry";
import { registerUnipileWebhookRoutes } from "../unipileWebhook";
import { registerUnsubscribeRoute } from "../unsubscribe";
import { registerPasswordAuthRoutes } from "../passwordAuth";
import { registerLLMStreamRoutes } from "../llmStreamRoute";
import { registerProposalsStreamRoutes } from "../proposalsStreamRoute";
import { registerEmailBuilderStreamRoutes } from "../emailBuilderStreamRoute";
import { registerAccountBriefsStreamRoutes } from "../accountBriefsStreamRoute";
import { registerMailboxStreamRoutes } from "../mailboxStreamRoute";
import { seedToursForAllWorkspaces } from "../seedTours";
import { seedAreDemoForAllWorkspaces } from "../seedAreDemo";
import { runRawMigrations } from "./rawMigrations";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerScimRoutes(app);
  registerEmailTrackingRoutes(app);
  registerUnipileWebhookRoutes(app);
  registerUnsubscribeRoute(app);
  registerPasswordAuthRoutes(app);
  registerLLMStreamRoutes(app);
  registerProposalsStreamRoutes(app);
  registerEmailBuilderStreamRoutes(app);
  registerAccountBriefsStreamRoutes(app);
  registerMailboxStreamRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // Run any unapplied raw SQL migrations in the background after startup.
  // Fire-and-forget: never blocks server startup or healthcheck.
  // 5s delay to let the DB connection pool settle first.
  setTimeout(() => {
    runRawMigrations().catch((e) =>
      console.error("[RawMigrations] unhandled error:", e)
    );
  }, 5_000);
  // Seed demo guided tours for all workspaces on startup (idempotent)
  setTimeout(() => {
    seedToursForAllWorkspaces().catch((e) =>
      console.error("[SeedTours] startup seed failed:", e)
    );
  }, 15_000); // 15s delay to let DB settle
  // Seed a populated demo ARE campaign for all workspaces (idempotent).
  // 25s delay so the 0071 are_*/prospect_* migration has applied first.
  setTimeout(() => {
    seedAreDemoForAllWorkspaces().catch((e) =>
      console.error("[SeedAreDemo] startup seed failed:", e)
    );
  }, 25_000);

  // Daily email verification maintenance: snapshot + auto re-verify
  // Run once on startup (catches up if server was down), then every 24h
  const runMaintenance = () => {
    runDailyVerificationMaintenance().catch((e) =>
      console.error("[VerifyMaintenance] daily run failed:", e),
    );
  };
  setTimeout(runMaintenance, 30_000); // delay 30s to let DB settle
  setInterval(runMaintenance, 24 * 60 * 60 * 1000);

  // Advance in-flight Reoon bulk verification jobs server-side every 2 min
  // so results land even if the SDR closed the tab after kicking off a
  // big (e.g. 10k) bulk verify.
  const runVerifyJobs = () => {
    advanceRunningVerificationJobs().catch((e) =>
      console.error("[VerifyJobs] advance run failed:", e),
    );
  };
  setTimeout(runVerifyJobs, 45_000);
  setInterval(runVerifyJobs, 2 * 60 * 1000);

  // Sequence execution engine: process active enrollments every 5 minutes
  const runSequenceEngine = () => {
    processEnrollments()
      .catch((e) => console.error("[SequenceEngine] cron run failed:", e))
      .then(() =>
        // Right after each enrollment tick, fire the auto-send pass so any
        // drafts the engine just created can dispatch without waiting for
        // a human if the workspace has aiAutoSendEnabled + threshold met.
        autoSendForAllWorkspaces().then((res) => {
          if (res.dispatched > 0 || res.failed > 0 || res.skippedNullScore > 0) {
            // skippedNullScore is surfaced explicitly because "auto-send
            // doesn't fire" is a common gotcha — usually the recipient
            // contacts haven't had relStrengthScore computed yet.
            console.log(
              `[autoSend] tick complete — dispatched=${res.dispatched} skipped=${res.skipped} (nullScore=${res.skippedNullScore}, lowScore=${res.skippedLowScore}) failed=${res.failed} (${res.workspacesProcessed} workspace${res.workspacesProcessed === 1 ? "" : "s"})`,
            );
          }
        }),
      )
      .catch((e) => console.error("[autoSend] cron run failed:", e));
  };
  setTimeout(runSequenceEngine, 60_000); // first run after 60s
  setInterval(runSequenceEngine, 5 * 60 * 1000); // every 5 minutes

  // Hourly segment → sequence auto-enroll: evaluate all enabled rules
  const runSegmentEnrollment = () => {
    runSegmentEnrollmentForAllWorkspaces().catch((e: unknown) =>
      console.error("[SegmentEnroll] hourly run failed:", e)
    );
  };
  setTimeout(runSegmentEnrollment, 90_000); // first run after 90s
  setInterval(runSegmentEnrollment, 60 * 60 * 1000); // every hour


  // ARE engine: drive every active Autonomous Revenue Engine campaign through
  // enrich → screen → sequence → enroll → dispatch → counters, every 10 min.
  const runAre = () => {
    runAreEngine().catch((e) =>
      console.error("[AreEngine] cron run failed:", e)
    );
  };
  setTimeout(runAre, 30_000); // first run 30s after boot (so a freshly-launched campaign sees activity fast)
  setInterval(runAre, 3 * 60 * 1000); // every 3 minutes — feels continuous to the user while still giving each tick room to finish

  // Pipeline-health alerts: scan every workspace's open opportunities for
  // staleness, low-prob deals closing soon, and no-champion deals. Runs on
  // its own 15-min loop — alerts are user-actionable, no benefit to the
  // tighter cadence the ARE engine needs.
  const runAlerts = () => {
    runPipelineAlertsCron().catch((e) =>
      console.error("[PipelineAlertsCron] run failed:", e)
    );
  };
  setTimeout(runAlerts, 2 * 60 * 1000); // first run 2 minutes after boot
  setInterval(runAlerts, 15 * 60 * 1000); // every 15 minutes

  // Nightly AI pipeline batch: midnight cron for leads above score threshold
  const scheduleNightlyBatch = () => {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0); // next midnight
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    setTimeout(() => {
      const runBatch = () => {
        runNightlyBatch().catch((e) =>
          console.error("[NightlyBatch] nightly run failed:", e)
        );
        expireInvitations().catch((e) =>
          console.error("[InviteExpiry] nightly run failed:", e)
        );
        sendExpiryWarningEmails().catch((e) =>
          console.error("[InviteExpiry] warning email job failed:", e)
        );
      };
      runBatch();
      setInterval(runBatch, 24 * 60 * 60 * 1000); // every 24h after first run
    }, msUntilMidnight);
    console.log(`[NightlyBatch] Scheduled for midnight (~${Math.round(msUntilMidnight / 60000)} min away)`);
  };
  scheduleNightlyBatch();

  // Inbound reply poller: check IMAP/Gmail inboxes every 60s for new replies
  startInboundReplyPoller();
}

startServer().catch(console.error);
