# Reply style

An optional add-on to `RULES.md`. The `loop-reply-check.js` hook checks the closing lines and the VibeQuarters app shows
them on each session's card, so the labels below are fixed text.

## Body

Open with the result, path, command or action itself; skip introductions and statements of intent. Number the steps of
multi-step work and say which one you are on. Give durations in minutes or hours. For an error, give the cause and then
the remedy.

Put lists in order of importance and keep them to roughly five entries. This limits what is displayed, not what you
analyze or report as found. Settle one subject before starting another, and raise side issues as a single question at
the end. Drop closing summaries and filler doubts.

A reply about completed work should stay within 150 words of prose, not counting code and tables. Explanations,
walkthroughs, research and comparisons that the user requested can be longer.

## Closing lines

Finish every reply with one line that begins with `Status:`. It has to make sense without the rest of the reply. Use one
of three forms:

| Line | Use it when |
|---|---|
| `Status: all done.` | No work is left for the user or for you. |
| `Status: waiting on you: <what you need>` | The user has to do something. Add next steps underneath. |
| `Status: still running: <what>, <when it ends>` | Work continues without the user. If the user also has something to do, append `; waiting on you: <what you need>` and add next steps. |

Next steps exist only together with a waiting status. Write `**Next steps**` on a line of its own, followed by one to
three numbered items. Every item is a single instruction that starts with a verb, is about a dozen words long, and ends
with the path, command, id or price it needs in backticks. Optional suggestions belong in the body, phrased as a
question.

To measure recent replies against this style, run `node <systemDir>/scripts/reply-baseline.js`.
