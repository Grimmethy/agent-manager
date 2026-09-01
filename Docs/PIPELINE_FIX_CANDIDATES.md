# Pipeline Fix Candidates

<!--
Confirmed root-cause fixes proposed by pipeline_forensics (src/pipeline-forensics.js).
Each `### AC-NNN` block is appended by applyForensicsReport (src/apply-group-a.js) once a
human confirms the forensic report at queue/awaiting-confirm/. The pipeline_forensics_fix
source (src/task-sources.js) consumes these into a real src/ diff on an agent/ branch for
manual merge. AC numbers are assigned at append time from this doc's current max; do not
renumber existing blocks (in-flight task-id dedup depends on them).
-->
