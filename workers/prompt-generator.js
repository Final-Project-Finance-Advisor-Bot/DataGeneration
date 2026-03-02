/**
 * generator.js (single-file module)
 *
 * Exports:
 *   - generateJsonlBatch({ label, amount, model }) -> returns JSONL string
 *
 * Notes:
 * - Designed to run in Node (fetch available in Node 20+).
 * - Prompts are read from disk via mapping.
 */

import fs from "fs";
import path from "path";

// label to prompt mapping
export const LABEL_TO_PROMPT_FILE = {
  LLM_CHAT: "./prompts/LLM_CHAT.txt",
  OPEN_PORTFOLIO: "./prompts/OPEN_PORTFOLIO.txt",
  EDU_PORTFOLIO: "./prompts/EDU_PORTFOLIO.txt",
  OPEN_LEARNING: "./prompts/OPEN_LEARNING.txt",
  EDU_LEARNING: "./prompts/EDU_LEARNING.txt",
  OPEN_FEE_IMPACT_CALCULATOR: "./prompts/OPEN_FEE_IMPACT_CALCULATOR.txt",
  EDU_FEE_IMPACT_CALCULATOR: "./prompts/EDU_FEE_IMPACT_CALCULATOR.txt",
  CONTEXT_PORTFOLIO: "./prompts/CONTEXT_PORTFOLIO.txt",
  CONTEXT_LEARNING: "./prompts/CONTEXT_LEARNING.txt",
  DOMAIN_QUERIES: "./prompts/DOMAIN_QUERIES.txt",
};

const DEFAULT_NUM_PREDICT = 4000;

// public orchestrator

/**
 * Keeps calling generateJsonlBatch until we have exactly `targetLines` JSONL lines.
 * If we overshoot, we hard-trim to the first `targetLines` lines.
 * @param {string} params.label
 * @param {number} params.targetLines
 * @param {string} [params.model]
 * @param {number} [params.numPredict]
 * @returns {Promise<string>} JSONL string with exactly targetLines lines + trailing newline
 */
export async function generateJsonlExact({
  label,
  targetLines,
  model = process.env.OLLAMA_MODEL || "llama3.2",
  numPredict = DEFAULT_NUM_PREDICT,
}) {
  if (!Number.isInteger(targetLines) || targetLines <= 0) {
    throw new Error("targetLines must be a positive integer");
  }

  const collected = [];

  while (collected.length < targetLines) {
    const remaining = targetLines - collected.length;

  
    // ask for only what we still need
    const chunkJsonl = await generateJsonlBatch({
      label,
      amount: remaining,
      model,
      numPredict,
    });

    const chunkLines = splitJsonlLines(chunkJsonl);
    console.log(
      `[${label}] got ${chunkLines.length} lines, total=${collected.length + chunkLines.length}/${targetLines}`,
    );

    if (chunkLines.length === 0) continue;

    collected.push(...chunkLines);
  }

  // Hard cut (in case we ever overshoot due to future changes)
  const exact = collected.slice(0, targetLines);

  return exact.join("\n") + "\n";
}

function splitJsonlLines(jsonl) {
  if (!jsonl) return [];
  return jsonl
    .trimEnd()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
// batch call
/**
 * Generates JSONL for a single label and returns it to the caller.
 * This is a single Ollama call + extraction pass (may return fewer than requested).
 *
 * @param {Object} params
 * @param {string} params.label Intent label to generate for (must exist in LABEL_TO_PROMPT_FILE).
 * @param {number} params.amount How many examples to ask for.
 * @param {string} [params.model] Ollama model name (e.g. "llama3.2").
 * @param {number} [params.numPredict] Ollama num_predict.
 * @returns {Promise<string>} JSONL string (newline-delimited JSON objects).
 */
export async function generateJsonlBatch({
  label,
  amount,
  model = process.env.OLLAMA_MODEL || "llama3.2",
  numPredict = DEFAULT_NUM_PREDICT,
}) {
  // basic error handling
  if (!label) throw new Error("label is required");
  if (!Number.isInteger(amount) || amount <= 0)
    throw new Error("amount must be a positive integer");

  // grab file name from mapping
  const promptFile = LABEL_TO_PROMPT_FILE[label];
  if (!promptFile) throw new Error(`No prompt mapping for label: ${label}`);
  const promptTemplate = fs.readFileSync(path.resolve(promptFile), "utf8");

  // use placeholders in .txt prompts: {{N}} and {{LABEL}}, this can be added to after
  const prompt = promptTemplate
    .replaceAll("{{N}}", String(amount))
    .replaceAll("{{LABEL}}", label);
 
   
  // call ollama
  const raw = await ollamaCall({ model, prompt, numPredict });

  // extract jsonL & return
  const jsonlLines = extractJsonlLines(raw, label);
  return jsonlLines.join("\n") + (jsonlLines.length ? "\n" : "");
}

// ollama call

/**
 * calls ollama local chat endpoint and returns raw text output.
 */
async function ollamaCall({ model, prompt, numPredict }) {

  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Follow the instructions carefully. Output the required JSON objects.",
        },
        { role: "user", content: prompt },
      ],
      options: {
        temperature: 0.9,
        top_p: 0.9,
        num_predict: numPredict,
      },
    }),
  });
  console.log("Response recieved")

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data?.message?.content ?? "";
}

// JSONL extraction + validation

function extractJsonlLines(raw, expectedLabel = null) {
  const blocks = extractJsonObjects(raw);

  const good = [];
  for (const block of blocks) {
    let obj;
    try {
      obj = JSON.parse(block);
    } catch {
      continue;
    }

    if (!obj || typeof obj !== "object") continue;
    if (typeof obj.text !== "string") continue;
    if (typeof obj.label !== "string") continue;

    if (expectedLabel && obj.label !== expectedLabel) continue;

    const cleaned = {
      text: normalizeText(obj.text),
      label: obj.label,
    };

    if (!cleaned.text) continue;

    // check label has correct intent structure
    if (cleaned.label.startsWith("OPEN_") && !hasOpenIntent(cleaned.text))
      continue;
    if (cleaned.label.startsWith("EDU_") && !hasEduIntent(cleaned.text))
      continue;
    if (cleaned.label === "LLM_CHAT" && !hasChatIntent(cleaned.text)) continue;

    good.push(JSON.stringify(cleaned));
  }

  return good;
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Extract JSON objects from messy model output using brace balancing.
 * Regex alone is not reliable because braces can appear inside strings,
 * and model output can include multiple objects + extra prose.
 */
function extractJsonObjects(raw) {
  // find opening braces
  const starts = [];
  const startRe = /\{/g;
  let m;
  while ((m = startRe.exec(raw)) !== null) starts.push(m.index);

  const results = [];
  const spans = [];

  // itterate over the opening braces
  for (const start of starts) {
    // check if brackets already identified
    if (spans.some(([a, b]) => start >= a && start <= b)) continue;

    // grab the next 250 charecters
    const slice = raw.slice(start);
    const head = slice.slice(0, 250);

    // ensure it has the correct labels
    const hasTextKey = head.includes('"text"') || head.includes("'text'");
    const hasLabelKey = head.includes('"label"') || head.includes("'label'");
    if (!hasTextKey || !hasLabelKey) continue;

    // find terminating brace
    const end = findMatchingBraceIndex(raw, start);
    if (end === -1) continue;

    const objStr = raw.slice(start, end + 1);
    spans.push([start, end]);
    // push found jsonL
    results.push(objStr);
  }

  // return jsonl
  return results;
}

/**
 * Finds the index of the matching closing brace for a JSON object.
 *
 * Starting from an opening `{`, this function walks forward through
 * the string while tracking nested brace depth.
 *
 * Important:
 * - Braces inside quoted strings must be ignored.
 * - Escaped quotes (e.g. \" inside text) must not terminate strings.
 *
 * This allows reliable extraction of JSON objects from noisy LLM output
 * where multiple objects and additional prose may be present.
 *
 * @param {string} s Full raw model output.
 * @param {number} startIndex Index of the opening `{`.
 * @returns {number} Index of the matching `}` or -1 if not found.
 */
function findMatchingBraceIndex(s, startIndex) {
  let depth = 0;
  let inString = false;
  // stores which quote opened the string (" or ')
  let stringQuote = null;

  // tracks escape characters inside strings (e.g. \" )
  let escaped = false;

  // scan forward through the string
  for (let i = startIndex; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      // previous character was "\" so this one is escaped
      if (escaped) {
        escaped = false;
        continue;
      }

      // escape sequence begins
      if (ch === "\\") {
        escaped = true;
        continue;
      }

      // closing quote ends the string
      if (ch === stringQuote) {
        inString = false;
        stringQuote = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      continue;
    }

    // opening brace increases nesting depth
    if (ch === "{") depth++;

    // closing brace reduces nesting depth
    if (ch === "}") {
      depth--;

      // we have found the matching closing brace
      if (depth === 0) return i;

      // check if malformed structure
      if (depth < 0) return -1;
    }
  }

  // no matching brace found
  return -1;
}

// intent checks

function hasOpenIntent(text) {
  const t = String(text).toLowerCase();
  const hasAction =
    /\b(open|launch|start|run|do|try|use|show|go to|bring up|demonstrate|enter|access|navigate to|switch to|load|show me|display|pull up|head to|move to|jump to|direct me to|route me to|let me access|take me into)\b/.test(
      t,
    ) ||
    /\b(i want to|can you|let me|take me to|could you|please open|I'd like to open|I want to access|I need to go|help me open)\b/.test(
      t,
    );

  const isEducation =
    /\b(difference between|what is|explain|definition|how does|compare|pros and cons|why|teach me|help me understand|walk me through|break down|clarify|unpack|overview of|summarise)\b/.test(
      t,
    );

  return hasAction && !isEducation;
}

function hasEduIntent(text) {
  const t = String(text).toLowerCase().trim();

  const eduSingle =
    /\b(explain|definition|compare|why|teach|learn|clarify)\b/.test(t);

  const eduPhrases =
    /\b(what is|how does|how do i|how to|difference between|pros and cons|help me understand|walk me through|show me how)\b/.test(
      t,
    );

  const hasQuestionShape =
    t.endsWith("?") ||
    /\b(how can i|where do i start|best way to|what should i)\b/.test(t);

  const openSingle =
    /\b(open|launch|start|run|use|enter|access|navigate|switch|load)\b/.test(t);

  const openPhrases =
    /\b(go to|bring up|show me|pull up|head to|move to|jump to|direct me to|route me to|let me access|take me to|take me into)\b/.test(
      t,
    );

  const isOpen = (openSingle || openPhrases) && !(eduSingle || eduPhrases);

  return (eduSingle || eduPhrases || hasQuestionShape) && !isOpen;
}

function hasChatIntent(text) {
  const t = String(text).toLowerCase().trim();

  const looksOpen =
    /\b(open|launch|start|run|do|try|use|show|go to|bring up|demonstrate|enter|access|navigate to|switch to|load|show me|display|pull up|head to|move to|jump to|direct me to|route me to|let me access|take me into)\b/.test(
      t,
    );

  return !looksOpen;
}
