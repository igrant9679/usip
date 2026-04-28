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
import { runDailyVerificationMaintenance } from "../routers/emailVerification";
import { processEnrollments } from "../sequenceEngine";
import { runNightlyBatch } from "../nightlyBatch";
import { runSegmentEnrollmentForAllWorkspaces } from "../routers/segmentRules"; // eslint-disable-line
import { registerEmailTrackingRoutes } from "../emailTracking";
import { startInboundReplyPoller } from "../inboundReplyPoller";
import { expireInvitations, sendExpiryWarningEmails } from "../inviteExpiry";
import { registerUnipileWebhookRoutes } from "../unipileWebhook";
import { registerPasswordAuthRoutes } from "../passwordAuth";

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
  registerPasswordAuthRoutes(app);
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

  // Daily email verification maintenance: snapshot + auto re-verify
  // Run once on startup (catches up if server was down), then every 24h
  const runMaintenance = () => {
    runDailyVerificationMaintenance().catch((e) =>
      console.error("[VerifyMaintenance] daily run failed:", e),
    );
  };
  setTimeout(runMaintenance, 30_000); // delay 30s to let DB settle
  setInterval(runMaintenance, 24 * 60 * 60 * 1000);

  // Sequence execution engine: process active enrollments every 5 minutes
  const runSequenceEngine = () => {
    processEnrollments().catch((e) =>
      console.error("[SequenceEngine] cron run failed:", e)
    );
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
