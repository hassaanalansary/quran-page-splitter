import type { TFunction } from "i18next";

import type { ProcessJob } from "@/lib/api";

/** What to say about a job that waits for a worker: how many jobs are ahead of it.
 * Every screen that shows a job uses it, so a queued job reads the same everywhere. */
export function queuedJobLabel(t: TFunction, job: ProcessJob): string {
  const ahead = job.queue_position ?? 0;
  return ahead > 0 ? t("jobQueue.ahead", { count: ahead }) : t("jobQueue.next");
}
