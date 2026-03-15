# PreToolUse hook forks parentUuid chain in multi-turn sessions

Minimal repro for [anthropics/claude-code#33651](https://github.com/anthropics/claude-code/issues/33651).

When a `PreToolUse` hook is defined and the Agent SDK's `query()` is used with `canUseTool` + streaming input for multi-turn conversations, hook progress entries create a fork in the JSONL's `parentUuid` chain. `getSessionMessages` follows the progress branch, orphaning messages from the main conversation.

## Setup

```
npm install
```

The `.claude/settings.local.json` file defines a trivial async PreToolUse hook (`echo noop`).

## Run

```
node repro.mjs
```

## What happens

Turn 1: Claude calls a tool → `canUseTool` fires → AskUserQuestion → answer → response.
Turn 2: follow-up message.

The JSONL ends up with a forked `parentUuid` tree:

```
assistant (tool_use)
├── Branch A: tool_result → AskUserQuestion → tool_result → response  ← ORPHANED
└── Branch B: progress(PreToolUse) → ... → system → user(turn 2)     ← followed by getSessionMessages
```

**Expected**: 0 orphaned entries.
**Actual**: 4-5 orphaned entries — `getSessionMessages` drops them.

## Key isolation

Remove the `PreToolUse` hook from `.claude/settings.local.json` and rerun — the chain is clean (0 orphans). The hook is the only variable.
