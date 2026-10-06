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

  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '.check_runs[] | {name, status, conclusion}');
  if (runs.error) return res(false, runs.error);
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return res(false, suites.error);

  if (runs.items.length === 0) {
    return res(false, `no check runs on ${short(sha)} in ${repo}; push the commit and wait for CI to start, or check that the workflows run on this branch`);
  }
  const failing = runs.items.filter((c) => c.status === 'completed' && !GOOD.has(c.conclusion));
  const pending = runs.items.filter((c) => c.status !== 'completed');
  const badSuites = suites.items.filter((s) => s.status !== 'completed' || !GOOD.has(s.conclusion));

  if (!failing.length && !pending.length && !badSuites.length) {
    const counts = {};
    for (const c of runs.items) counts[c.conclusion] = (counts[c.conclusion] || 0) + 1;
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    return res(true, `CI green at ${short(sha)} in ${repo}: ${runs.items.length} check runs (${tally}), ${suites.items.length} check suites completed`);
  }
  const lines = [`CI not green at ${short(sha)} in ${repo}:`];
  if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
  if (pending.length) lines.push(`not completed: ${listSome(pending.map((c) => `${c.name} (${c.status})`), 20)}`);
  if (badSuites.length) {
    lines.push(`check suites not green: ${listSome(badSuites.map((s) => `${s.app || 'unknown app'} (${s.status === 'completed' ? s.conclusion : s.status}, ${s.runs ?? '?'} runs)`), 20)}`);
    if (badSuites.some((s) => s.status !== 'completed' && !s.runs)) {
      lines.push('A suite queued with no runs is either CI that has not started or an app that never reports on this repository; in the second case the owner can waive ci with a reason.');
    }
  }
  lines.push(`Fix or re-run what failed, wait for what is still running, then run gishra check ci ${task.id} again.`);
  return res(false, lines.join('\n'));
}

module.exports = { run };
