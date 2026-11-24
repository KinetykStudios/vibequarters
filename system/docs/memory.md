# Memory

Four layers, each read differently. Write a fact to the one you will read it back from, and only there.

| Layer | Where | Written by | Read |
| --- | --- | --- | --- |
| Memory files | `~/.claude/projects/<key>/memory/*.md`, indexed by `MEMORY.md` | you or Claude, on purpose | `MEMORY.md` every session; a file's body when a prompt calls for it (`loop-recall.js`) |
| Learning loop | `memory/loop/LEARNING-LOG.md` and its ledgers (`PREFERENCES`, `PATTERNS`, `MISTAKES`, `EFFICIENCY`) | `/evolve` | the log every session, the ledgers when it points at them |
| Resume point | `memory/loop/SPOT.md` | `loop-spot.js`, every turn | after a compact, a clear or a restart |
| Transcripts | `~/.claude/projects/<key>/*.jsonl` | Claude Code | by search, for "did we do this before" |

- On a conflict, a memory file wins over the learning log, and both win over a transcript.
- A recalled fact that names a file, flag or function is checked before it is used: any layer can be stale.
- The resume point is hot state, not memory. What should last goes to a memory file or through `/evolve`.

## How recall picks (`loop-recall.js`)
No model, no embeddings, no network. Each prompt is scored against every memory file's name, description and text (a name or description match counts most). Below the floor it adds nothing, so a conversation stays a conversation. Above it, up to three bodies and the names of the next matches are added as context with the prompt, within a fixed character budget.
