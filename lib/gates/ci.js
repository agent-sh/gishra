'use strict';
// Gate `check ci ID`: GitHub check runs and check suites on the exact submitted commit. A run
// that never started, was cancelled or is still going is not a pass.
const { fail, short, gh, ghFailure, sameSha, listSome } = require('./common');

const GOOD = new Set(['success', 'neutral', 'skipped']);
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';

// Every page of a list endpoint, one JSON object per element (gh prints one per line with --jq).
async function ghList(ctx, endpoint, filter) {
  const r = await gh(ctx, ['api', endpoint, '--paginate', '--jq', filter]);
  if (!r.ok) return { error: `${ghFailure(r, `gh api ${endpoint}`)}. ${CHECK_HINT}` };
  try {
    return { items: r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  } catch (e) {
    return { error: `could not read gh api ${endpoint} output: ${e.message}` };
  }
}

async function run(ctx) {
  const { task, project } = ctx;
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with gishra submit ${task.id} --sha SHA`);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  const { repo } = project;
  const sha = task.sha;
  const ref = `https://github.com/${repo}/commit/${sha}/checks`;
  const res = (ok, summary) => ({ ok, summary, sha, ref });

  if (task.pr) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'headRefOid']);
    if (!v.ok) return res(false, `${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let head;
    try {
      head = JSON.parse(v.stdout).headRefOid;
    } catch (e) {
      return res(false, `could not read gh pr view ${task.pr} output: ${e.message}`);
    }
    if (!sameSha(head, sha)) {
      return res(false, `PR head moved: PR #${task.pr} head is ${short(head)}, the task's submitted sha is ${short(sha)}. Submit the new head (gishra submit ${task.id} --sha ${head}) or push ${short(sha)} back, then check again.`);
    }
  }

  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '.check_runs[] | {name, status, conclusion, app: .app.slug}');
  if (runs.error) return res(false, runs.error);
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return res(false, suites.error);

  if (runs.items.length === 0) {
    return res(false, `no check runs on ${short(sha)} in ${repo}; push the commit and wait for CI to start, or check that the workflows run on this branch`);
  }
  const failing = runs.items.filter((c) => c.status === 'completed' && !GOOD.has(c.conclusion));
  const pending = runs.items.filter((c) => c.status !== 'completed');
  // GitHub opens a suite for every installed app that listens for pushes, and apps that never
  // report on this repository (review bots, assistants) leave it queued with no runs for good.
  // A suite with no runs means CI has not started only when its app runs checks on this commit.
  const runApps = new Set(runs.items.map((c) => c.app));
  const idle = (s) => s.status !== 'completed' && !s.runs && !runApps.has(s.app);
  const ignored = suites.items.filter(idle);
  const badSuites = suites.items.filter((s) => !idle(s) && (s.status !== 'completed' || !GOOD.has(s.conclusion)));
  const ignoredNote = ignored.length ? `\nIgnored ${ignored.length} queued suite${ignored.length === 1 ? '' : 's'} with no runs from apps that report no checks on this commit: ${listSome(ignored.map((s) => s.app || 'unknown app'), 20)}` : '';

  if (!failing.length && !pending.length && !badSuites.length) {
    const counts = {};
    for (const c of runs.items) counts[c.conclusion] = (counts[c.conclusion] || 0) + 1;
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    return res(true, `CI green at ${short(sha)} in ${repo}: ${runs.items.length} check runs (${tally}), ${suites.items.length - ignored.length} check suites completed${ignoredNote}`);
  }
  const lines = [`CI not green at ${short(sha)} in ${repo}:`];
  if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
  if (pending.length) lines.push(`not completed: ${listSome(pending.map((c) => `${c.name} (${c.status})`), 20)}`);
  if (badSuites.length) {
    lines.push(`check suites not green: ${listSome(badSuites.map((s) => `${s.app || 'unknown app'} (${s.status === 'completed' ? s.conclusion : s.status}, ${s.runs ?? '?'} runs)`), 20)}`);
  }
  if (ignoredNote) lines.push(ignoredNote.trim());
  lines.push(`Fix or re-run what failed, wait for what is still running, then run gishra check ci ${task.id} again.`);
  return res(false, lines.join('\n'));
}

module.exports = { run };
