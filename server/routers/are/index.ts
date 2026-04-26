import { router } from "../../_core/trpc";
import { icpRouter } from "./icp";
import { campaignsRouter } from "./campaigns";
import { prospectsRouter } from "./prospects";
import { executionRouter } from "./execution";
import { scraperRouter } from "./scraper";

export const areRouter = router({
  icp: icpRouter,
  campaigns: campaignsRouter,
  prospects: prospectsRouter,
  execution: executionRouter,
  scraper: scraperRouter,
});
