# Changelog

## 0.1.0

First public release.

- Live view of the Claude Code sessions on this computer: status, current step, subagents, context gauge, cost, failures and checks.
- Usage stats from the transcripts on disk, with API-equivalent spend.
- A 3D office where sessions and subagents work at desks, as modeled people (13 of them, MIT licensed).
- Optional control mode: answer permission prompts, plan approvals and questions from the page through a Claude Code hook.
- Optional assistant on your own Claude login, with approve windows, a generic never-auto list, and an AI judge that ships off.
- Optional voice (ElevenLabs) and speech input (a local whisper.cpp build).
- Coordination board, Queue, deploy wall, keep-warm, agent switches and a plan line for one or more accounts. Each is off or hidden until there is something behind it.
- An approvals chooser with four choices, all carrying the same never-auto list.
- An installer and uninstaller for the hooks, mods, commands and rules. Full also sets the app up, so only a restart of Claude Code is left.
- Demo mode with made-up sessions and data for every panel: `npm run demo`.
