import { query } from "@anthropic-ai/claude-agent-sdk";
const response = query({
  prompt: (async function*() {
    yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Human: Say hi" }] } };
  })(),
  options: { cwd: process.cwd(), model: "sonnet", permissionMode: "bypassPermissions" },
});
for await (const msg of response) {
  if (msg.type === "result") { console.log("OK"); break; }
}
setTimeout(() => process.exit(0), 200);
