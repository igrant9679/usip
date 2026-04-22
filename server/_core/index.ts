import "dotenv/config";
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
}

startServer().catch(console.error);
