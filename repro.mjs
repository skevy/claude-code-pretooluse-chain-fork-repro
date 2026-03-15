/**
 * Minimal repro: PreToolUse hooks fork the parentUuid chain in multi-turn sessions.
 *
 * https://github.com/anthropics/claude-code/issues/33651
 *
 * Run: npm install && node repro.mjs
 *
 * Expected: 0 orphaned entries (clean parentUuid chain)
 * Actual:   4-5 orphaned entries (messages from turn 1 lost)
 */
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CWD = process.cwd();
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ── Two-turn conversation via streaming input ──

let injectResolve;
let done = false;

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Human: Use AskUserQuestion to ask me one question with 3 options. After I answer, say TURN_1_DONE.",
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: "",
  };
  while (!done) {
    yield await new Promise((r) => (injectResolve = r));
  }
}

// ── canUseTool: blocks for AskUserQuestion, auto-allows everything else ──

let resolveApproval;

const response = query({
  prompt: prompt(),
  options: {
    cwd: CWD,
    model: "sonnet",
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    canUseTool: async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        return new Promise((r) => (resolveApproval = r));
      }
      return { behavior: "allow", updatedInput: input };
    },
  },
});

// Auto-answer AskUserQuestion when it appears
const poll = setInterval(() => {
  if (resolveApproval) {
    clearInterval(poll);
    resolveApproval({
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }],
        answers: { "Pick?": "A" },
      },
    });
    resolveApproval = null;
  }
}, 50);

// ── Run both turns ──

let sessionId;
let turns = 0;

for await (const msg of response) {
  if (msg.type === "system" && "session_id" in msg) sessionId = msg.session_id;

  if (msg.type === "result") {
    turns++;
    if (turns === 1) {
      // Inject turn 2 after a short delay
      setTimeout(
        () =>
          injectResolve({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: "Human: Say TURN_2_DONE" }],
            },
            parent_tool_use_id: null,
            session_id: sessionId ?? "",
          }),
        1000
      );
    }
    if (turns === 2) {
      done = true;
      break;
    }
  }
}

// ── Analyze JSONL ──

let jsonlPath;
for (const dir of readdirSync(PROJECTS_DIR)) {
  const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
  try {
    statSync(p);
    jsonlPath = p;
    break;
  } catch {}
}

const entries = readFileSync(jsonlPath, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// Walk parentUuid chain from last entry
const byUuid = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
const chain = new Set();
let cur = entries[entries.length - 1];
while (cur) {
  if (cur.uuid) chain.add(cur.uuid);
  cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
}

const orphaned = entries.filter((e) => e.uuid && !chain.has(e.uuid));

// ── Check getSessionMessages ──

const sdkMessages = await getSessionMessages(sessionId, { dir: CWD });

// Count what the JSONL actually contains (messages only, not progress/system)
const allMessages = entries.filter(
  (e) => e.message?.role === "user" || e.message?.role === "assistant"
);
// Among those, find ones with AskUserQuestion tool_use
const hasAskUserQuestion = allMessages.some((e) =>
  (e.message?.content ?? []).some(
    (b) => b.type === "tool_use" && b.name === "AskUserQuestion"
  )
);
// Check if getSessionMessages includes AskUserQuestion
const sdkHasAskUserQuestion = sdkMessages.some((m) =>
  (m.message?.content ?? []).some(
    (b) => b.type === "tool_use" && b.name === "AskUserQuestion"
  )
);

console.log(`Session: ${sessionId}`);
console.log(`JSONL entries with uuid: ${entries.filter((e) => e.uuid).length}`);
console.log(`On chain from last: ${chain.size}`);
console.log(`Orphaned: ${orphaned.length}`);
console.log();
console.log(`JSONL has ${allMessages.length} user/assistant messages`);
console.log(`getSessionMessages returned ${sdkMessages.length} messages`);
console.log(`JSONL contains AskUserQuestion: ${hasAskUserQuestion}`);
console.log(`getSessionMessages contains AskUserQuestion: ${sdkHasAskUserQuestion}`);

let fail = false;

if (orphaned.length > 0) {
  fail = true;
  console.log("\n⚠️  FAIL: parentUuid chain is forked — messages orphaned");
  for (const o of orphaned) {
    const tools = (o.message?.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => b.name);
    console.log(
      `  ${o.type.padEnd(12)} role=${(o.message?.role ?? "-").padEnd(10)} tools=${tools.join(",") || "-"}`
    );
  }
}

if (sdkMessages.length < allMessages.length) {
  fail = true;
  console.log(
    `\n⚠️  FAIL: getSessionMessages dropped ${allMessages.length - sdkMessages.length} messages`
  );
}

if (hasAskUserQuestion && !sdkHasAskUserQuestion) {
  fail = true;
  console.log(
    "\n⚠️  FAIL: AskUserQuestion is in the JSONL but missing from getSessionMessages"
  );
}

if (!fail) {
  console.log("\n✅ PASS — no orphans, all messages returned");
}

process.exitCode = fail ? 1 : 0;

setTimeout(() => process.exit(process.exitCode ?? 0), 200);
