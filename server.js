import express from "express";
import fs from "fs";
import path from "path";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";
import crypto from "crypto";

const app = express();
app.use(express.json());

// constants
const PORT = 3001;
const DATA_DIR = "./data";
const JOB_FILE = "./jobs.json";
let BATCH_SIZE = 300;
const TARGET_PER_LABEL = 6000;
const JOB_TTL_HOURS = 6;
const JOB_TTL_MS = JOB_TTL_HOURS * 60 * 60 * 1000;

// set up swagger

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Dataset Coordinator",
      version: "1.0.0",
    },
  },
  apis: ["./server.js"], // if server file name differs, change this or use ["./**/*.js"]
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// helpers

/**
 * Writes the current coordinator job state to the jobs file,
 * allowing active dataset generation work to be tracked across
 * workers and process restarts.
 * @param {Array<Object>} jobs List of job reservations to store.
 */
function writeJobs(jobs) {
  fs.writeFileSync(JOB_FILE, JSON.stringify(jobs, null, 2));
}

/**
 * Active = within TTL AND not marked done
 */
function activeJobs(jobs) {
  const cutoff = Date.now() - JOB_TTL_MS;
  return jobs.filter((j) => j.createdAt > cutoff && j.IS_DONE !== true);
}

/**
 * Counts the number of lines in a JSONL file.
 * Returns 0 if the file does not exist or is empty.
 * @returns {Number} number of lines in the file
 */
function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) return 0;
  return content.split("\n").length;
}
/**
 * Marks active jobs belonging to a worker as completed.
 *
 * @param {Array<Object>} jobsRaw List of persisted jobs.
 * @param {string} workerId Worker requesting job replacement.
 * @returns {void}
 */
function killJobs(jobsRaw, workerId) {
  const cutoff = Date.now() - JOB_TTL_MS;
  let killedAny = false;

  for (const j of jobsRaw) {
    const sameWorker = (j.workerId || "unknown") === workerId;
    const isActive = j.createdAt > cutoff && j.IS_DONE !== true;

    if (sameWorker && isActive) {
      j.IS_DONE = true;
      j.killedAt = Date.now();
      j.killedBy = workerId;
      killedAny = true;
    }
  }

  if (killedAny) writeJobs(jobsRaw);
}

/**
 * Computes the number of active jobs per worker.
 * @param {Array<Object>} jobs List of job reservations.
 * @returns {Object<string, number>} Mapping of workerId to job count.
 */
function computeWorkerBreakdown(jobs) {
  const byWorker = {};
  for (const j of jobs) {
    const w = j.workerId || "unknown";
    byWorker[w] = (byWorker[w] || 0) + 1;
  }
  return byWorker;
}

// ---------------- Diagram Logic ----------------
/**
 * Reads dataset files and calculates the number of samples per label.
 * Scans the data directory for JSONL files and counts the number
 * of lines in each file, where each line represents one training example.
 * @async
 * @returns {Promise<Object<string, number>>} Mapping of label name to sample count.
 */
async function fetchLabelCounts() {
  // grab all jsonl files
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl"));
  const counts = {};
  // itterate through each files
  for (const file of files) {
    const label = file.replace(".jsonl", "");
    // store counts per file
    counts[label] = countLines(path.join(DATA_DIR, file));
  }
  return counts;
}

/**
 * Reads the persisted job reservation file from disk.
 * The coordinator maintains job reservations in a JSON file to track
 * Behaviour:
 * - Returns an empty array if the job file does not exist.
 * - Returns an empty array if the file is empty or invalid.
 * - Safely parses stored job objects when present.
 * @returns {Array<Object>} List of persisted job reservations.
 */
function fetchExistingJobs() {
  try {
    if (!fs.existsSync(JOB_FILE)) return [];
    const raw = fs.readFileSync(JOB_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Adds active job reservations to current label counts.
 * This prevents multiple workers allocating work for the same
 * label batch simultaneously by accounting for in-flight jobs.
 * @param {Object<string, number>} counts Current filesystem sample counts per label.
 * @param {Array<Object>} jobs Active job reservations.
 * @returns {Object<string, number>} Updated label counts including reserved batches.
 */
function addJobsToCounts(counts, jobs) {
  const updated = { ...counts };
  for (const job of jobs) {
    updated[job.label] = (updated[job.label] || 0) + job.batchSize;
  }
  return updated;
}

/**
 * Determines the label with the smallest effective dataset size
 * that has not yet reached the configured target.
 * @param {Object<string, number>} counts Mapping of label names to
 * current effective sample counts.
 * @returns {string|null} The label requiring the next batch of
 * generation, or null if all labels have reached the target.
 */
function smallestLabel(counts, excluded=[]) {
  const excludedSet = new Set((excluded || []).map(String))

  let smallest = null;
  let value = Infinity;

  for (const label in counts) {
    if (excludedSet.has(label)) continue;
    if (counts[label] >= TARGET_PER_LABEL) continue;
    if (counts[label] < value) {
      smallest = label;
      value = counts[label];
    }
  }
  return smallest;
}

// ---------------- Routes ----------------
/**
 * @openapi
 * /jobs/next:
 *   post:
 *     tags: [Jobs]
 *     summary: Allocate next dataset job
 *     description: >
 *       Allocates a new generation job using filesystem-backed label counts
 *       and in-flight job reservations (TTL) to keep labels balanced.
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workerId:
 *                 type: string
 *                 example: "macbook-pro"
 *     responses:
 *       200:
 *         description: Job allocated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [id, label, batchSize, createdAt, workerId, IS_DONE]
 *               properties:
 *                 id: { type: string }
 *                 label: { type: string }
 *                 batchSize: { type: integer }
 *                 createdAt: { type: integer, description: Epoch ms }
 *                 workerId: { type: string }
 *                 IS_DONE: { type: boolean }
 *       204:
 *         description: No jobs remaining (all labels reached target)
 */
app.post("/jobs/next", async (req, res) => {
  // grab worker id
  const workerId = req.body?.workerId || "unknown";
  if(workerId == "server-worker") {
      BATCH_SIZE = 50
  }
  console.log(BATCH_SIZE)

  const excludeLabels = Array.isArray(req.body?.excludeLabels)? req.body.excludeLabels :[];
  console.log(excludeLabels)
  // gather data asynchronously
  const [labelCounts, jobsRaw] = await Promise.all([
    fetchLabelCounts(),
    fetchExistingJobs(),
  ]);

  // reallocate jobs if worker process dies
  killJobs(jobsRaw, workerId);

  // call the next label
  const jobs = activeJobs(jobsRaw);
  const effectiveCounts = addJobsToCounts(labelCounts, jobs);
  const label = smallestLabel(effectiveCounts, excludeLabels);

  // no more work to complete
  if (!label) return res.status(204).send();

  // build response
  const job = {
    id: crypto.randomUUID(),
    label,
    batchSize: BATCH_SIZE,
    createdAt: Date.now(),
    workerId,
    IS_DONE: false,
    // job lifecycle:
    // staged indicated that it has not been pushed to GIT Repo
    STAGED: true,
  };

  const updatedJobs = [...jobsRaw, job];
  writeJobs(updatedJobs);

  // send response
  res.json(job);
});

/**
 * @openapi
 * /stats:
 *   get:
 *     tags: [Stats]
 *     summary: Get coordinator stats
 *     description: >
 *       Returns filesystem label counts, active job reservations, effective counts,
 *       and progress toward target per label.
 *     responses:
 *       200:
 *         description: Stats payload
 */
app.get("/stats", async (_req, res) => {
  const [labelCounts, jobsRaw] = await Promise.all([
    fetchLabelCounts(),
    fetchExistingJobs(),
  ]);

  const active = activeJobs(jobsRaw);
  const effectiveCounts = addJobsToCounts(labelCounts, active);

  // per-label progress
  const labels = Object.keys(labelCounts).sort();
  const progress = {};

  // build progress summary per label
  for (const label of labels) {
    // Samples already written to disk
    const completed = labelCounts[label] || 0;

    // Samples currently reserved by active jobs
    const reserved = effectiveCounts[label] - completed;

    progress[label] = {
      completed, // finished samples
      reserved, // in-flight batches
      effective: effectiveCounts[label] || 0, // completed + reserved
      target: TARGET_PER_LABEL, // goal per label
      remaining: Math.max(0, TARGET_PER_LABEL - completed), // still needed
      isComplete: completed >= TARGET_PER_LABEL, // target reached
    };
  }

  // returns response
  res.json({
    targetPerLabel: TARGET_PER_LABEL,
    batchSize: BATCH_SIZE,
    ttlHours: JOB_TTL_HOURS,
    labelsTracked: labels.length,
    activeJobs: active.length,
    activeJobsByWorker: computeWorkerBreakdown(active),
    labelCounts,
    effectiveCounts,
    progress,
  });
});

/**
 * @openapi
 * /jobs/{id}/complete:
 *   post:
 *     tags: [Jobs]
 *     summary: Complete a job and append generated JSONL to the label file
 *     description: >
 *       Appends a worker-generated JSONL batch to the dataset file for the job's label,
 *       then marks the job as completed (IS_DONE=true). The coordinator uses the job's
 *       stored label (not the request body) as the source of truth.
 *
 *       Completion is rejected if the job is expired (TTL), already completed,
 *       not found, or the workerId does not match the allocated worker.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Job id returned by /jobs/next
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workerId, jsonl]
 *             properties:
 *               workerId:
 *                 type: string
 *                 example: "macbook-pro"
 *                 description: Worker identifier; must match the workerId stored on the job.
 *               jsonl:
 *                 type: string
 *                 example: "{\"text\":\"open the portfolio manager\",\"label\":\"OPEN_PORTFOLIO\"}\n"
 *                 description: >
 *                   One or more JSONL lines (newline-delimited). The server will append
 *                   these lines to data/{job.label}.jsonl. A trailing newline is recommended.
 *     responses:
 *       200:
 *         description: Job completed and data appended
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, id, label, appendedLines]
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 id:
 *                   type: string
 *                   example: "e5485b65-5b42-4bf4-972d-a1f928a8b0f6"
 *                 label:
 *                   type: string
 *                   example: "CONTEXT_BACKTEST"
 *                 appendedLines:
 *                   type: integer
 *                   example: 400
 *                 completedAt:
 *                   type: integer
 *                   description: Epoch milliseconds
 *                   example: 1709131234567
 *       400:
 *         description: Invalid request body (missing workerId/jsonl)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "workerId and jsonl are required"
 *       403:
 *         description: Worker mismatch (workerId does not match the allocated job)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "worker mismatch"
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "job not found"
 *       409:
 *         description: Job already completed or job expired (TTL)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "job expired"
 *       500:
 *         description: Server error (e.g., file append/write failure)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "failed to append jsonl"
 */
app.post("/jobs/:id/complete", (req, res) => {
  // fetch inputs from request
  const { id } = req.params;
  const { workerId, jsonl } = req.body;

  // find requested job
  const jobsRaw = fetchExistingJobs();
  const job = jobsRaw.find((j) => j.id === id);

  // error handling
  if (!job) return res.status(404).json({ error: "job not found" });

  if (job.workerId !== workerId)
    return res.status(403).json({ error: "worker mismatch" });

  if (job.IS_DONE)
    return res.status(409).json({ error: "job already completed" });

  const cutoff = Date.now() - JOB_TTL_MS;

  if (job.createdAt < cutoff)
    return res.status(409).json({ error: "job expired" });

  // append data
  const filePath = path.join(DATA_DIR, `${job.label}.jsonl`);
  const payload = jsonl.endsWith("\n") ? jsonl : jsonl + "\n";
  fs.appendFileSync(filePath, payload);

  // pass by ref ammend job
  job.IS_DONE = true;
  job.completedAt = Date.now();

  writeJobs(jobsRaw);

  // respond 200
  res.json({ ok: true });
});

app.get("/openapi.json", (_req, res) => {
  res.json(swaggerSpec);
});

app.listen(PORT, () => {
  console.log(`Coordinator running ${PORT}`);
  console.log(`Swagger http://localhost:${PORT}/docs`);
});
