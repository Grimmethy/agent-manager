'use strict';

// archived-dirs.js -- one definition of "this directory is an archive; never treat what is inside as live code".
//
// 2026-10-08 (TaxHarvest): the retired per-client deliverables flow was moved to TaxHarvest/archive/client-deliverables/. It had been a steady
// source of hygiene work (278 finished tasks, 23 live ones), and every directory walker in the pipeline would have kept finding the archived copies:
// function-length / dead-code / observability scans would file new work on code nobody runs, and grounding would cite archived files as live
// (or make a basename lookup look ambiguous because the archive holds a second copy of the same file). Each walker had its own hard-coded skip list and
// there was no per-project way to retire an area, so the convention is: a directory named `archive` / `archived` (optionally with a leading underscore,
// any case) is skipped by every walker. Moving code into one is the whole "retire it" step. The hygiene repo has the same rule in scan-utils.js.
//
// Only WALKS skip them: a file read by an explicit path, or a task that names an archived file, is unaffected.

const ARCHIVED_DIR_RE = /^_?archived?$/i;

const isArchivedDirName = (name) => ARCHIVED_DIR_RE.test(String(name || ''));

module.exports = { isArchivedDirName, ARCHIVED_DIR_RE };
