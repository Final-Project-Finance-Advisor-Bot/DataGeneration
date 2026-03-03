import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const keyPath = process.env.GCP_KEY_PATH;
const bucketName = process.env.GCP_BUCKET;

if (!keyPath) throw new Error("missing env var gcp_key_path");
if (!bucketName) throw new Error("missing env var gcp_bucket");

const storage = new Storage({ keyFilename: keyPath });
const bucket = storage.bucket(bucketName);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function requireDir(p) {
  if (!p) die("missing arg artifact_dir");
  if (!fs.existsSync(p)) die(`artifact dir not found ${p}`);
  return p;
}

function requireFile(p) {
  if (!fs.existsSync(p)) die(`missing file ${p}`);
  return p;
}

// usage
// node modelUploader.js TF-IDF ./out/intent-model_current
// node modelUploader.js BERT  ./out/intent-model__2026-03-02__1730
async function main() {
  const modelType = process.argv[2];
  const artifactDir = requireDir(process.argv[3]);

  if (!modelType) die("missing arg model_type");

  // check files exist
  const modelFile = requireFile(path.join(artifactDir, "model.joblib"));
  const metaFile = requireFile(path.join(artifactDir, "metadata.json"));

  // replace "current" with timestamp for versioning
  const versionName = path
    .basename(artifactDir)
    .replace("current", new Date().toISOString().replace(/[:.]/g, "-"));

  // target layout
  // TF-IDF_models_current/model.joblib
  // TF-IDF_models_archive/<version>/model.joblib
  const currentPrefix = `${modelType}_models_current`;
  const archivePrefix = `${modelType}_models_archive/${versionName}`;

  // upload archive
  await bucket.upload(modelFile, {
    destination: `${archivePrefix}/model.joblib`,
  });
  await bucket.upload(metaFile, {
    destination: `${archivePrefix}/metadata.json`,
  });

  // overwrite current
  await bucket.upload(modelFile, {
    destination: `${currentPrefix}/model.joblib`,
  });
  await bucket.upload(metaFile, {
    destination: `${currentPrefix}/metadata.json`,
  });

  console.log("uploaded archive and updated current");
}

main().catch((err) => {
  console.error("upload failed", err);
  process.exit(1);
});
