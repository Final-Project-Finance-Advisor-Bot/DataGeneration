/**
 * worker-stub.js
 * Minimal worker loop to validate coordinator behaviour end-to-end.
 * - Requests a job
 * - Generate jsonl data
 * - Completes the job by posting JSONL back to coordinator
 * Env:
 *   WORKER_ID="macbook-pro"
 *   COORDINATOR_URL="http://192.168.1.103:3001"
 */
import { generateJsonlExact } from "./prompt-generator.js";

const WORKER_ID = process.env.WORKER_ID;
const COORDINATOR_URL = process.env.COORDINATOR_URL;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!WORKER_ID) die("WORKER_ID not set (e.g. export WORKER_ID=macbook-pro)");
if (!COORDINATOR_URL)
  die(
    "COORDINATOR_URL not set (e.g. export COORDINATOR_URL=http://192.168.1.103:3001)",
  );

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function main() {
  let shouldRun = true;

  while (shouldRun) {
    // get job
    console.log("Requesting next job...");
    const nextRes = await postJson(`${COORDINATOR_URL}/jobs/next`, {
      workerId: WORKER_ID,
    });

    if (nextRes.status === 204) {
      console.log("No jobs remaining (204). Exiting.");
      return;
    }

    if (!nextRes.ok) {
      const text = await nextRes.text().catch(() => "");
      throw new Error(`Failed /jobs/next: ${nextRes.status} ${text}`);
    }

    const job = await nextRes.json();
    const { id, label, batchSize } = job;
    console.log(`Allocated job ${id} -> ${label} (${batchSize})`);

    // generate prompts using Ollama
    const jsonl = await generateJsonlExact({
      label,
      targetLines: batchSize,
    });

    // complete job
    const completeRes = await postJson(
      `${COORDINATOR_URL}/jobs/${id}/complete`,
      {
        workerId: WORKER_ID,
        jsonl,
      },
    );

    if (!completeRes.ok) {
      const text = await completeRes.text().catch(() => "");
      throw new Error(
        `Failed /jobs/${id}/complete: ${completeRes.status} ${text}`,
      );
    }

    console.log(`Completed job ${id}`);

    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
