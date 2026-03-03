import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
dotenv.config();
// config
const KEY_PATH = process.env.GCP_KEY_PATH;
const BUCKET_NAME = process.env.GCP_BUCKET;

if (!KEY_PATH || !BUCKET_NAME) {
  console.error(
    "GCP_KEY_PATH and GCP_BUCKET environment variables must be set in same directory by using a .env file (e.g. GCP_KEY_PATH=./key.json and GCP_BUCKET=my-bucket)",
  );
  process.exit(1);
}

/**
 * Lists all files in GCP bucket. Usage:
 */
async function listModels() {
  const storage = new Storage({
    keyFilename: KEY_PATH,
  });

  // grab bucket reference and list files
  const bucket = storage.bucket(BUCKET_NAME);
  const [files] = await bucket.getFiles();

  // print file names
  console.log(`Files in bucket ${BUCKET_NAME}:\n`);
  for (const file of files) {
    console.log(file.name);
  }
}

listModels().catch((err) => {
  console.error("Failed listing bucket:", err);
  process.exit(1);
});
