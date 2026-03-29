# Coordinator Usage Guide

## Overview

The Dataset Coordinator distributes dataset generation work across multiple worker machines and safely commits generated data to the repository.

Workers request generation batches from the coordinator, generate labelled JSONL data locally, and submit completed batches back for persistence.

The coordinator ensures:

- Balanced dataset growth across intent labels
- Single-writer Git updates
- Protection against stalled or expired workers
- Safe distributed dataset generation

> Full architectural documentation is available in the documentation repository.

---

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/Final-Project-Finance-Advisor-Bot/DataGeneration.git
cd DataGeneration
```

---

### 2. Install Dependencies

Requirements:

- Node.js ≥ v20
- npm

Install dependencies:

```bash
npm install
```

---

## Running the Coordinator Server

The coordinator exposes an HTTP API used by worker machines.

Start the development server:

```bash
npm run dev
```

Expected output:

```
Coordinator running 3001
Swagger http://localhost:3001/docs
```

Swagger documentation will be available at:

> http://localhost:3001/docs

---

## Worker Connectivity

Machines on the same network can connect using the host machine IP address.

Example:

> http://192.168.x.x:3001

To find your IP address:

### macOS

```bash
ipconfig getifaddr en0
```

### Ubuntu / Linux

```bash
hostname -I
```

---

## Cron Job - Automatic Git Synchronisation

The cron workflow periodically commits generated dataset updates.

The cron process:

1. Checks for completed staged jobs
2. Detects modified dataset files
3. Commits dataset updates
4. Pushes changes to GitHub

Only one dataset file is processed per execution cycle.

Recommended interval:

> Every 2 minutes

---

## macOS Cron Setup

Edit your crontab:

```bash
crontab -e
```

Add:

```
*/2 * * * * cd /PATH/TO/DataGeneration && /PATH/TO/node cron/stage-and-push.js >> cron.log 2>&1
```

Verify cron is installed:

```bash
crontab -l
```

Monitor logs:

```bash
tail -f cron.log
```

---

## Ubuntu / Linux Cron Setup

Install cron if required:

```bash
sudo apt install cron
```

Enable service:

```bash
sudo systemctl enable cron
sudo systemctl start cron
```

Edit crontab:

```bash
crontab -e
```

Add job:

```
*/2 * * * * cd /PATH/TO/DataGeneration && /usr/bin/node cron/stage-and-push.js >> cron.log 2>&1
```

Check cron service:

```bash
systemctl status cron
```

---

## Coordinator API

Swagger documentation is automatically generated.

Available endpoints include:

- POST /jobs/next
- POST /jobs/{id}/complete
- GET /stats

Swagger UI:

> http://localhost:3001/docs

Raw OpenAPI specification:

> http://localhost:3001/openapi.json

---

## Recommended Workflow

1. Start coordinator server
2. Start worker machines
3. Workers request jobs
4. Workers generate JSONL batches
5. Workers submit completed batches
6. Cron job stages and pushes dataset updates automatically

   ## Worker Usage Guide

Workers are responsible for generating labelled training data locally and submitting completed batches back to the dataset coordinator service.

Workers may be executed on any machine capable of running **Node.js (v20+)** and **Ollama** locally.

The worker operates as a lightweight execution client and does not perform dataset storage or Git operations. All dataset persistence is handled centrally by the coordinator.

---

### Prerequisites

Before running a worker, ensure the following software is installed:

- Node.js v20 or later (required for native `fetch` support)
- Ollama installed and running locally
- Required Ollama model pulled locally (e.g. `llama3.2`)
- Network access to the coordinator service

Example:

```bash
ollama pull llama3.2
```

Confirm Ollama is running:

```bash
ollama serve
```

Ensure the Ollama API is reachable locally:

```bash
curl http://localhost:11434/api/tags
```

---

### Environment Configuration

Workers require two environment variables.

| Variable | Description |
|---|---|
| WORKER_ID | Unique identifier for the worker machine |
| COORDINATOR_URL | Base URL of the dataset coordinator API |

Example configuration:

```bash
export WORKER_ID="laptop-worker"
export COORDINATOR_URL="http://192.168.1.103:3001"
```

The worker will terminate immediately if these variables are not provided.

---

### Starting a Worker

Navigate to the worker directory and start the process:

```bash
node worker-start.js
```

Once started, the worker will:

1. Request a job allocation from the coordinator.
2. Receive a label and batch size.
3. Generate training examples locally using Ollama.
4. Submit generated JSONL data back to the coordinator.
5. Request the next available job.

Execution continues until the coordinator reports that no jobs remain.

---

### Monitoring Progress

Workers log local execution progress directly to the console, including:

- Job allocation events
- Training data generation activity
- Batch completion confirmation

Example worker output:

```text
Allocated job a011211b -> CONTEXT_BACKTEST (400)
Generating training data...
Completed job a011211b
```

Dataset progress across all workers is monitored through the **coordinator statistics endpoint**, which provides the current dataset counts and overall generation status.

This endpoint should be queried periodically to observe:

- Samples generated per intent label
- Remaining targets
- Overall dataset completion progress

Example request:

```bash
curl http://<COORDINATOR_URL>/stats
```

The coordinator acts as the source of truth for dataset state, particularly when multiple workers are operating concurrently.

---

### Stopping a Worker

Workers may be stopped safely at any time using:

```bash
CTRL + C
```

Incomplete jobs will automatically return to the coordinator allocation pool.

# Create Model Service – Usage Guide

The Create Model service is responsible for training, evaluating, and packaging intent classification models for the Financial Advisor Bot.

It consumes locally generated JSONL datasets and produces:

- model.joblib  
- metadata.json  
- misclassifications.jsonl  

Models are saved locally and may then be uploaded to Google Cloud Storage using the model uploader utility.

---

## Important Security Notice

**Important – All Passwords and Credentials Are Provided Within the Coursera Submission**

Due to these repositories being publicly accessible, passwords, service account credentials, API keys, and other sensitive configuration details cannot be exposed within the source code or repository documentation without creating personal security risk.

All required credentials and access information necessary to run, deploy, or evaluate the system are therefore provided securely as part of the official Coursera submission materials.

No credentials are stored in this repository.



---

## Prerequisites

Before running the Create Model service, ensure:

- Python 3.10+ (I used 3.13.1)
- Virtual environment configured
- Required Python packages installed
- Dataset files present in `data/` directory

---

## Python Environment Setup
Create a virtual environment:

```bash
python -m venv venv
```

Activate it:

```bash
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## Dataset Requirements

The model expects JSONL files in the `data/` directory.

Each line must contain:

```json
{"text": "example prompt", "label": "INTENT_NAME"}
```

Multiple `.jsonl` files are supported. All files in `data/` are merged automatically.

---

## Training the Model

Navigate to the model-maker directory:

```bash
cd model-maker
```

Run the training script:

```bash
python train_tfidf_intent_model.py \                   
  --dataset ../data \
  --ngrams 1,2 \
  --max-features 10000
```

The script will:

- Print dataset statistics  
- Output validation accuracy and macro F1  
- Display confusion matrix  
- Save artifacts to:

```text
out/intent-model_current/
```

To view all available configuration options:

```bash
python train_tfidf_intent_model.py --help
```

---

## Output Artifacts

After training, the following files are produced:

```text
out/intent-model_current/
  model.joblib
  metadata.json
  misclassifications.jsonl
```

### model.joblib
Serialized sklearn Pipeline containing:
- TfidfVectorizer
- LogisticRegression classifier

### metadata.json
Contains:
- Training timestamp  
- Label list  
- Validation metrics  
- Model parameters  
- Python and library versions  

### misclassifications.jsonl
Contains validation examples where predictions were incorrect, including:
- original text  
- true label  
- predicted label  
- probability  
- margin  

This file is used for label boundary debugging.

---

## Testing the Model Locally

To test predictions:

```bash
python testModel.py "what is the difference between a share and a portfolio"
```

The script prints:

- Predicted label  
- Per-class probabilities (sorted)  

---

## Uploading the Model to GCP

### Prerequisites

Before uploading a model, ensure the following are installed:

- Node.js v20 or later
- Access to the service account credentials (provided separately in the Coursera submission)
- A configured `.env` file inside the `model-maker/` directory

Install Node dependencies:

```bash
npm install
```

---

### Environment Configuration

Create a `.env` file in the `model-maker/` directory:

```bash
touch .env
```

Add the following variables:

```bash
GCP_KEY_PATH=/absolute/path/to/service-account.json
GCP_BUCKET=financal-advisor-bot-models
```

Important:

- The service account JSON file is provided separately in the Coursera submission.
- Do not commit the `.env` file.
- The path must be absolute.

---

After successful training, upload the model:

```bash
node modelUploader.js TF-IDF ./out/intent-model_current
```

The uploader will:

- Archive the version  
- Update the current model pointer  

Target bucket structure:

```text
financal-advisor-bot-models/
  TF-IDF_models_current/
    model.joblib
    metadata.json

  TF-IDF_models_archive/
    intent-model__<timestamp>/
      model.joblib
      metadata.json

  BERT_models_current/
  BERT_models_archive/
```

---

## Monitoring Model Quality

Key metrics printed during training:

- Accuracy  
- Macro F1  
- Confusion matrix  

Macro F1 is the primary evaluation metric as it balances performance across all intent classes.

Misclassification analysis should be performed before promoting a model to production.
