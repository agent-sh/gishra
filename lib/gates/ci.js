'use strict';
// Gate `check ci ID`: GitHub check runs and check suites on the exact submitted commit. A run
// or suite that never started, was cancelled or is still going is not a pass. Review caps
// need an explicit project policy because the independent review can satisfy that requirement.
// `submitReport` makes the same judgment when a worker submits, so a head that is still running
// or red is refused before it is recorded, and revuto's open inline findings reach the worker.
const { fail, short, gh, ghFailure, sameSha, listSome } = require('./common');
const Hosted = require('../ci-hosted');

const GOOD = new Set(['success', 'neutral', 'skipped']);
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';
// Revuto's logins carry an app suffix, so match the name within the login.
const REVUTO = /revuto/i;
// Where a failing job's log starts: a TAP `not ok`, a spec-reporter cross or an assertion.
const FAILURE_LINE = /\bnot ok\b|\bFAIL\b|✖|✗|AssertionError/;
// Bounds on what a refusal prints: the first failing lines of each job, and the log tail when
// no failure marker shows up.
const LOG_LINES = 8;
const LOG_TAIL = 6;
const LOG_JOBS = 3;
// The orchestrator allows a submit with CI still running by writing this line in the brief.
const FORCE_PENDING = /^[ \t]*(?:[-*][ \t]+)?force-ci-pending:[ \t]*allowed[ \t]*$/im;
// A shimmed agent's gh policy (lib/shim.js) refuses gh api, which these reads need.
const POLICY_REFUSAL = /is not allowed by this agent's agent file/;
const POLICY_NOTE = "this agent's gh policy refuses gh api, so submit did not read it. The orchestrator's check ci judges the head before merge.";

function refusedByPolicy(text) {
  return POLICY_REFUSAL.test(String(text));
}

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

// The check runs and suites at one commit.
async function fetchChecks(ctx, repo, sha) {
  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '.check_runs[] | {name, status, conclusion, app: .app.slug, suite: .check_suite.id, url: .details_url, output: {title: .output.title, summary: .output.summary}}');
  if (runs.error) return { error: runs.error };
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {id, app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return { error: suites.error };
  return { runs: runs.items, suites: suites.items };
}

// The judgment `check ci` and submit both make on one commit's checks. Ignored apps and capped
// reviews are set aside here; what is left is pending, failing or green.
function judge(policy, runs, suites) {
  const ignore = new Set(policy.ignore_apps);
  const caps = policy.capped_review.map((rule) => ({ app: rule.app, pattern: new RegExp(rule.pattern, 'i') }));
  const required = policy.required;
  const ciRuns = runs.filter((c) => !ignore.has(c.app));
  const ciSuites = suites.filter((x) => !ignore.has(x.app));
  const capped = new Set(ciRuns.filter((c) => {
    if (c.status !== 'completed' || c.conclusion !== 'failure') return false;
    const output = [c.output?.title, c.output?.summary].filter((s) => typeof s === 'string').join('\n');
    return caps.some((r) => r.app === c.app && r.pattern.test(output));
  }));
  function cappedSuite(s) {
    if (s.id == null || s.status !== 'completed' || s.conclusion !== 'failure') return false;
    const linked = ciRuns.filter((c) => c.suite === s.id && c.app === s.app);
    // Require the complete suite so one cap cannot hide another workflow or an unseen failure.
    return linked.length === s.runs && linked.some((c) => capped.has(c))
      && linked.every((c) => capped.has(c) || (c.status === 'completed' && GOOD.has(c.conclusion)));
  }
  const requiredRuns = ciRuns.filter((c) => typeof c.name === 'string' && required.some((name) => c.name.startsWith(name)));
  return {
    ignore,
    ciRuns,
    ciSuites,
    capped,
    failing: ciRuns.filter((c) => c.status === 'completed' && !GOOD.has(c.conclusion) && !capped.has(c)),
    pending: ciRuns.filter((c) => c.status !== 'completed'),
    missing: required.filter((name) => !ciRuns.some((c) => typeof c.name === 'string' && c.name.startsWith(name))),
    // Required jobs must actually run; skipped jobs and review caps cannot prove CI ran.
    unsuccessful: requiredRuns.filter((c) => c.status !== 'completed' || c.conclusion !== 'success'),
    badSuites: ciSuites.filter((x) => (x.status !== 'completed' || !GOOD.has(x.conclusion)) && !cappedSuite(x)),
  };
}

async function run(ctx) {
  const { task, project } = ctx;
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (project.ci?.local != null) return require('./local-ci').run(ctx);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  const { policy, error } = Hosted.resolve(project);
  if (error) return fail(error);
  const ignore = new Set(policy.ignore_apps);
  const { repo } = project;
  const sha = task.sha;
  const ref = `https://github.com/${repo}/commit/${sha}/checks`;
  // Capped review runs are recorded by name: an orchestrator may waive review only for such a reviewer.
  let cappedNames = [];
  const res = (ok, summary) => ({ ok, summary, sha, ref, ...(cappedNames.length ? { capped_review: cappedNames } : {}) });

  if (task.pr) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'headRefOid,mergeable,mergeStateStatus']);
    if (!v.ok) return res(false, `${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let pr;
    try {
      pr = JSON.parse(v.stdout);
    } catch (e) {
      return res(false, `could not read gh pr view ${task.pr} output: ${e.message}`);
    }
    const head = pr?.headRefOid;
    if (!sameSha(head, sha)) {
      return res(false, `PR head moved: PR #${task.pr} head is ${short(head)}, the task's submitted sha is ${short(sha)}. Submit the new head (tower-crane submit ${task.id} --sha ${head}) or push ${short(sha)} back, then check again.`);
    }
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      return res(false, `PR #${task.pr} is CONFLICTING (${pr.mergeStateStatus || 'unknown merge state'}): resolve merge conflicts with the base branch and submit the new head. GitHub does not run pull_request workflows on a conflicting PR.`);
    }
    if (pr.mergeable !== 'MERGEABLE' || !pr.mergeStateStatus || pr.mergeStateStatus === 'UNKNOWN') {
      return res(false, `PR #${task.pr} mergeability is unknown or unavailable (${pr.mergeable || 'missing'}, ${pr.mergeStateStatus || 'missing'}); wait for GitHub to compute it, then retry tower-crane check ci ${task.id}.`);
    }
  }

  const checks = await fetchChecks(ctx, repo, sha);
  if (checks.error) return res(false, checks.error);
  const { ciRuns, ciSuites, capped, failing, missing, unsuccessful, pending, badSuites } = judge(policy, checks.runs, checks.suites);
  cappedNames = [...capped].map((c) => `${c.name} (${c.app})`);
  const cappedNote = capped.size ? `Nonblocking capped reviews as listed in project.json ci.capped_review: ${listSome(cappedNames, 20)}` : '';
  const skipped = [...ignore].map((app) => {
    const n = checks.suites.filter((x) => x.app === app).length;
    const m = checks.runs.filter((c) => c.app === app).length;
    return n || m ? `${app} (${n} suite${n === 1 ? '' : 's'}, ${m} run${m === 1 ? '' : 's'})` : null;
  }).filter(Boolean);
  const skippedNote = skipped.length ? `Ignored as listed in project.json ci.ignore_apps: ${skipped.join(', ')}` : '';

  const confirmedFailure = failing.some((c) => c.conclusion === 'failure') ? { confirmed_failure: true } : {};
  if (missing.length || unsuccessful.length) {
    const lines = [`CI not green at ${short(sha)} in ${repo}:`];
    if (missing.length) lines.push(`missing required check runs (ci.required): ${listSome(missing, 20)}`);
    if (unsuccessful.length) lines.push(`required check runs not successful: ${listSome(unsuccessful.map((c) => `${c.name} (${c.status === 'completed' ? c.conclusion : c.status})`), 20)}`);
    if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
    if (skippedNote) lines.push(skippedNote);
    if (cappedNote) lines.push(cappedNote);
    lines.push(`Every ci.required name or prefix needs matching completed, successful runs at the submitted head. Fix or wait for the required workflows, then run tower-crane check ci ${task.id} again.`);
    return { ...res(false, lines.join('\n')), ...confirmedFailure };
  }

  if (!ciRuns.some((c) => !capped.has(c))) {
    return res(false, [`no check runs on ${short(sha)} in ${repo} outside ignored apps and capped reviews; push the commit and wait for CI to start, or check that the workflows run on this branch`, skippedNote, cappedNote].filter(Boolean).join('\n'));
  }

  if (!failing.length && !pending.length && !badSuites.length) {
    const counts = {};
    for (const c of ciRuns) {
      const outcome = capped.has(c) ? 'capped review' : c.conclusion;
      counts[outcome] = (counts[outcome] || 0) + 1;
    }
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    return res(true, [`CI green at ${short(sha)} in ${repo}: ${ciRuns.length} check runs (${tally}), ${ciSuites.length} check suites completed`, skippedNote, cappedNote].filter(Boolean).join('\n'));
  }
  const lines = [`CI not green at ${short(sha)} in ${repo}:`];
  if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
  if (pending.length) lines.push(`not completed: ${listSome(pending.map((c) => `${c.name} (${c.status})`), 20)}`);
  if (badSuites.length) {
    lines.push(`check suites not green: ${listSome(badSuites.map((x) => `${x.app || 'unknown app'} (${x.status === 'completed' ? x.conclusion : x.status}, ${x.runs ?? '?'} runs)`), 20)}`);
    if (badSuites.some((x) => x.status !== 'completed' && !x.runs)) {
      lines.push('A suite with no runs is CI that has not started, or an app that never reports checks here; the owner can set ci.ignore_apps to skip such an app with tower-crane project set --ci-ignore-apps \'["APP-SLUG"]\'.');
    }
  }
  if (skippedNote) lines.push(skippedNote);
  if (cappedNote) lines.push(cappedNote);
  lines.push(`Fix or re-run what failed, wait for what is still running, then run tower-crane check ci ${task.id} again.`);
  return { ...res(false, lines.join('\n')), ...confirmedFailure };
}

function jobId(url) {
  return /\/job\/(\d+)/.exec(url || '')?.[1] ?? null;
}

// The first failing lines of one job's log, from its failed steps. gh prefixes each line with
// the job and step names and a timestamp; those are dropped.
async function failedLines(ctx, repo, job) {
  const r = await gh(ctx, ['run', 'view', '--job', job, '-R', repo, '--log-failed']);
  if (!r.ok) return [`(log unavailable: ${ghFailure(r, 'gh run view')})`];
  const lines = r.stdout.split(/\r?\n/).map((line) => {
    const parts = line.split('\t');
    return (parts.length >= 3 ? parts.slice(2).join('\t') : line).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').trimEnd();
  }).filter((line) => line.trim());
  const at = lines.findIndex((line) => FAILURE_LINE.test(line));
  return at < 0 ? lines.slice(-LOG_TAIL) : lines.slice(at, at + LOG_LINES);
}

// Revuto's open inline findings on the PR: its top-level comments on a line still in the diff
// that nobody has replied to.
async function revutoFindings(ctx, repo, pr) {
  const comments = await ghList(ctx, `repos/${repo}/pulls/${pr}/comments?per_page=100`, '.[] | {id, in_reply_to_id, path, line, body, user: .user.login}');
  if (comments.error) return { error: comments.error };
  const answered = new Set(comments.items.filter((c) => c.in_reply_to_id != null && !REVUTO.test(c.user || '')).map((c) => c.in_reply_to_id));
  const findings = comments.items
    .filter((c) => c.in_reply_to_id == null && REVUTO.test(c.user || '') && c.path && c.line != null && !answered.has(c.id))
    .map((c) => ({ path: c.path, line: c.line, body: String(c.body || '').trimEnd() }));
  return { findings };
}

// Submit's check of the PR's CI at the head being submitted, before the head is recorded.
// Failing checks always refuse, with the first failing lines of each failing job. Pending checks
// refuse unless `forcePending` is set (the caller checks the brief allows it); a forced submit
// reports the pending names in `forcedPending`. `report` lists the capped reviews and revuto's
// findings and is printed whether or not the submit is refused. A project with no repo or local
// CI has no GitHub checks to read here.
async function submitReport(ctx, project, { sha, pr, forcePending }) {
  if (!pr || !project.repo || project.ci?.local != null) return { refusal: null, report: '' };
  const { policy, error } = Hosted.resolve(project);
  if (error) return { refusal: error, report: '' };
  const repo = project.repo;
  const checks = await fetchChecks(ctx, repo, sha);
  if (checks.error && !refusedByPolicy(checks.error)) return { refusal: checks.error, report: '' };
  if (checks.error) return { refusal: null, report: `CI at ${short(sha)} in ${repo} was not checked: ${POLICY_NOTE}` };
  const j = judge(policy, checks.runs, checks.suites);

  const pending = [
    ...j.pending.map((c) => `${c.name} (${c.status})`),
    ...j.missing.map((name) => `${name} (not started)`),
    ...j.badSuites.filter((x) => x.status !== 'completed').map((x) => `${x.app || 'unknown app'} suite (${x.status})`),
  ];
  if (!pending.length && !j.ciRuns.some((c) => !j.capped.has(c))) pending.push(`no check runs on ${short(sha)} outside ignored apps and capped reviews yet`);
  const failed = [
    ...j.failing.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    ...j.unsuccessful.filter((c) => c.status === 'completed' && !j.failing.includes(c)).map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    ...j.badSuites.filter((x) => x.status === 'completed').map((x) => ({ name: `${x.app || 'unknown app'} suite`, conclusion: x.conclusion })),
  ];

  const found = await revutoFindings(ctx, repo, pr);
  if (found.error && !refusedByPolicy(found.error)) return { refusal: found.error, report: '' };
  const report = [];
  if (found.error) report.push(`revuto's inline findings on PR #${pr} were not read: ${POLICY_NOTE}`);
  if (j.capped.size) report.push(`Nonblocking capped reviews as listed in project.json ci.capped_review: ${listSome([...j.capped].map((c) => `${c.name} (${c.app})`), 20)}`);
  if (found.findings?.length) {
    const n = found.findings.length;
    report.push(`revuto left ${n} open inline finding${n === 1 ? '' : 's'} on PR #${pr} (listed for you; they do not block the submit):`);
    for (const f of found.findings) report.push(`  ${f.path}:${f.line}`, ...f.body.split(/\r?\n/).map((l) => `    ${l}`));
  }
  const reportText = report.join('\n');

  if (failed.length) {
    const lines = [`CI failed at ${short(sha)} in ${repo}: fix the failing checks, push, and submit again.`,
      `failing: ${listSome(failed.map((f) => `${f.name} (${f.conclusion})`), 20)}`];
    for (const f of failed.filter((x) => jobId(x.url)).slice(0, LOG_JOBS)) {
      lines.push(`${f.name} log:`, ...(await failedLines(ctx, repo, jobId(f.url))).map((l) => `  ${l}`));
    }
    if (pending.length) lines.push(`not completed: ${listSome(pending, 20)}`);
    return { refusal: lines.join('\n'), report: reportText };
  }
  if (pending.length && !forcePending) {
    return { refusal: `CI is still running at ${short(sha)} in ${repo}: wait for CI to finish, then submit again.\npending: ${listSome(pending, 20)}`, report: reportText };
  }
  if (pending.length) {
    return { refusal: null, report: [`CI still pending at ${short(sha)}, submitted with --force-ci-pending (the brief allows it): ${listSome(pending, 20)}`, reportText].filter(Boolean).join('\n'), forcedPending: pending };
  }
  return { refusal: null, report: reportText };
}

// Whether the brief lets a worker submit with CI still pending.
function forcePendingAllowed(briefText) {
  return FORCE_PENDING.test(String(briefText || ''));
}

module.exports = { run, submitReport, forcePendingAllowed };
