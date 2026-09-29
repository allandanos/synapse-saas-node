import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { JOB_NAMES, type JobName, JobsService } from "../worker/jobs.service";

/**
 * `pnpm jobs:run-once [--all | <name>…]` — await each named job exactly once
 * and exit, printing `name: count` per line. This is what a scheduler-triggered
 * container runs instead of the always-on loop. Exits non-zero on an unknown
 * name, on nothing selected, or when any job failed.
 */
export function selectJobs(argv: readonly string[]): { jobs: JobName[]; error?: string } {
  const names = argv.filter((argument) => argument !== "--all");
  if (argv.includes("--all")) return { jobs: [...JOB_NAMES] };
  if (names.length === 0) return { jobs: [], error: `Name at least one job or pass --all. Known: ${JOB_NAMES.join(", ")}` };
  const unknown = names.filter((name) => !(JOB_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) return { jobs: [], error: `Unknown job(s): ${unknown.join(", ")}. Known: ${JOB_NAMES.join(", ")}` };
  return { jobs: names as JobName[] };
}

async function main(): Promise<void> {
  const { jobs, error } = selectJobs(process.argv.slice(2));
  if (error !== undefined) {
    console.error(error);
    process.exit(2);
  }
  // The scheduler must not race the one-off run.
  process.env.SYNAPSE_WORKER_ENABLED = "false";
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["warn", "error"] });
  let failed = false;
  try {
    const service = app.get(JobsService);
    for (const name of jobs) {
      try {
        console.log(`${name}: ${String(await service.run(name))}`);
      } catch (jobError) {
        // Report and keep going: one job must never hide the others.
        console.log(`${name}: error: ${jobError instanceof Error ? jobError.message : String(jobError)}`);
        failed = true;
      }
    }
  } finally {
    await app.close();
  }
  if (failed) process.exit(1);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
