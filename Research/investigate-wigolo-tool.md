# Investigate wigolo

Source: https://github.com/KnockOutEZ/wigolo

Tags: wigolo, github, research-tools, evaluation

## Captured note (verbatim)

"This needs a follow up. It could potentially solve our research problems."

Status: Not yet evaluated. Repository not read in this pass.

## Evaluation questions

- What does wigolo do, and what is its license and maintenance status (last commit date, release activity)?
- What interface does it expose (CLI, library, MCP server, HTTP API), and what inputs and outputs does it produce?
- Which of our research problems does it address? (Open question for the owner; the research problems are not named in the task.)
- Does it call a model or network service? Any local model access must go through `src/local-client.js` (call / callOnce). No direct Ollama calls or model context size or keep-alive settings are planned here.
- Would integrating it add periodic work? If so, it must be event-triggered, not polled (ADR-0024).

## Decision needed

Which research problem should wigolo solve, and should the follow-up be a time-boxed evaluation only or include a prototype integration?

## Notes

No existing source files are changed by this task. A prototype integration, if approved, is a separate task.
