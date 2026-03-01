import fs from "fs";
import { execSync } from "child_process";

// constants
const JOB_FILE = "./jobs.json";
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

// run shell safely
function run(cmd) {
  console.log("Running:", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function cleanupExpiredStagedJobs(jobs) {
  // calc when job has expired
  const cutoff = Date.now() - JOB_TTL_MS;

  let updated = false;

  // itterate through all jobs
  for (const job of jobs) {
    // bool check if expired
    const expired = job.createdAt < cutoff;
    if (job.STAGED && expired) {
      console.log("Releasing expired staged job:", job.id);

      // make job expired
      job.STAGED = false;
      job.expiredAt = Date.now();

      updated = true;
    }
  }

  // write jobs to FS
  if (updated) {
    fs.writeFileSync(JOB_FILE, JSON.stringify(jobs, null, 2));
  }
}

function readJobs() {
  // check if job file exists
  if (!fs.existsSync(JOB_FILE)) return [];
  // returns parsed job file
  return JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
}

// pick one staged job
function getStagedJob(jobs) {
  return jobs.find((j) => j.STAGED === true && j.IS_DONE === true);
}

function main() {
  // get all jobs
  const jobs = readJobs();

  // clear all jobs
  cleanupExpiredStagedJobs(jobs);
  
  // grab 1 staged job
  const job = getStagedJob(jobs);

  if (!job) {
    console.log("No staged jobs");
    return;
  }

  const file = `data/${job.label}.jsonl`;
  console.log(file);

  // check git changes
  const status = execSync(`git status --porcelain "${file}"`).toString().trim();

  if (!status) {
    console.log("File not changed");
    return;
  }

  // push to git
  run(`git add "${file}"`);
  run(`git commit -m "Data generation for job:${job.id} completed"`);
  run(`git push`);

  // clear staged flag
  job.STAGED = false;
  job.pushedAt = Date.now();

  // update job file
  fs.writeFileSync(JOB_FILE, JSON.stringify(jobs, null, 2));

  console.log("Job pushed:", job.id);
}

main();
