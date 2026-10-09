'use strict';
// Gate `merge ID`: merges an accepted task's PR only while its head is still the accepted
// commit, then confirms on GitHub that it merged. A refused merge is reported, never retried.
const { fail, short, gh, ghFailure, errText, sameSha } = require('./common');

const METHODS = ['squash', 'merge', 'rebase'];

async function prView(ctx, repo, pr) {
  const r = await gh(ctx, ['pr', 'view', String(pr), '-R', repo, '--json', 'state,headRefOid,mergeCommit,isCrossRepository,autoMergeRequest,baseRefName']);
  if (!r.ok) return { error: ghFailure(r, `gh pr view ${pr}`) };
  try {
    return { pr: JSON.parse(r.stdout) };
  } catch (e) {
    return { error: `could not read gh pr view ${pr} output: ${e.message}` };
  }
}

function mergeOid(pr) {
  return pr.mergeCommit && pr.mergeCommit.oid ? pr.mergeCommit.oid : undefined;
}

// A PR GitHub reports merged is only confirmed: the result names what landed and nothing else changes.
function landed(task, repo, view) {
  const sha = task.sha;
  if (sameSha(view.headRefOid, sha)) {
    const ref = mergeOid(view);
    return { ok: true, sha, ref, confirmOnly: true, summary: `PR #${task.pr} in ${repo} was already merged at ${short(sha)}; merge commit ${short(ref)}` };
  }
  return { ok: false, sha, confirmOnly: true, summary: `PR #${task.pr} in ${repo} was merged with head ${short(view.headRefOid)}, not the accepted ${short(sha)}; the merged code was not the accepted code, so review what landed` };
}

// GitHub refuses gh pr merge for a stack member; members merge through the asynchronous
// merge REST API, which takes the head it must match and completes after the request returns.
// A PR still open ten minutes after the request stops the chain, and a later merge run
// confirms it once it lands.
const POLL_DEADLINE_MS = 10 * 60 * 1000;
const POLL_FIRST_MS = 1000;
const POLL_MAX_MS = 10000;
const ASYNC_FAILED = /fail|error|cancel|abort|conflict|reject/i;

function parsed(r) {
  try { return JSON.parse(r.stdout || '{}') || {}; } catch { return {}; }
}

function asyncFailure(body) {
  const status = body.status || body.state;
  if (ASYNC_FAILED.test(String(status))) return `${status}${body.error || body.message ? `: ${body.error || body.message}` : ''}`;
}

async function asyncMerge(ctx, t) {
  const { repo, base } = ctx.project;
  const before = await prView(ctx, repo, t.pr);
  if (before.error) return fail(before.error);
  if (before.pr.state !== 'OPEN') return fail(`${t.id}: PR #${t.pr} is ${before.pr.state}`);
  if (!sameSha(before.pr.headRefOid, t.sha)) return fail(`${t.id}: PR head moved from accepted ${short(t.sha)} to ${short(before.pr.headRefOid)}`);
  // A confirmed lower merge leaves this PR on the merged branch until GitHub retargets it.
  if (before.pr.baseRefName !== base) {
    const edit = await gh(ctx, ['pr', 'edit', String(t.pr), '-R', repo, '--base', base]);
    if (!edit.ok) return fail(ghFailure(edit, `retarget PR #${t.pr}`));
  }
  if (ctx.validateStack) {
    const reason = ctx.validateStack();
    if (reason) return fail(reason);
  }
  const endpoint = `repos/${repo}/pulls/${t.pr}/merge-async`;
  const cmd = ['api', endpoint, '--method', 'POST', '-f', 'merge_method=merge', '-f', `expected_head_sha=${before.pr.headRefOid}`];
  (ctx.log || (() => {}))(`merge: gh ${cmd.join(' ')}`);
  const post = await gh(ctx, cmd);
  if (!post.ok) return fail(`GitHub refused the asynchronous merge of PR #${t.pr}: ${post.missing ? 'gh not found on PATH' : errText(post, 10)}\nNothing was retried. Fix what GitHub names (required checks, reviews, conflicts, a moved head), then run tower-crane merge ${ctx.task.id} again.`);
  const response = parsed(post);
  const id = response.id ?? response.uuid;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let wait = POLL_FIRST_MS;
  let status = response.status || response.state;
  // A terminal response remains useful when later status or PR reads fail.
  let ended = asyncFailure(response);
  const refusal = (confirmation) => fail(`GitHub's asynchronous merge of PR #${t.pr} ended ${ended}, ${confirmation}\nNothing was retried. Fix what GitHub names, then run tower-crane merge ${ctx.task.id} again.`);
  let unread;
  // The PR is the source of truth. The job status only explains a wait or a refusal: a
  // failed poll (a 5xx, or a 404 once GitHub retires a finished job) leads to a PR read.
  for (;;) {
    if (id !== undefined) {
      const poll = await gh(ctx, ['api', `${endpoint}/${id}`]);
      if (poll.ok) {
        const body = parsed(poll);
        status = body.status || body.state || status;
        ended = asyncFailure(body) || ended;
      } else unread = `status poll failed: ${errText(poll)}`;
    }
    const after = await prView(ctx, repo, t.pr);
    if (after.error) unread = after.error;
    else if (after.pr.state === 'MERGED') {
      if (sameSha(after.pr.headRefOid, t.sha)) return { ok: true };
      return fail(`PR #${t.pr} merged with head ${short(after.pr.headRefOid)}, not the accepted ${short(t.sha)}; review what landed`);
    } else if (after.pr.state !== 'OPEN') return fail(`${t.id}: PR #${t.pr} is ${after.pr.state} after its asynchronous merge was requested`);
    else if (!sameSha(after.pr.headRefOid, t.sha)) return fail(`${t.id}: PR head moved from accepted ${short(t.sha)} to ${short(after.pr.headRefOid)} while merging; GitHub's head pin refuses it`);
    else if (ended) return refusal('and the PR is still open');
    if (Date.now() >= deadline) {
      if (ended) return refusal(`but the PR state could not be confirmed${unread ? `; last ${unread}` : ''}`);
      return fail(`PR #${t.pr} is not merged ${POLL_DEADLINE_MS / 60000} minutes after its asynchronous merge was requested (job ${status || 'pending'}${unread ? `; last ${unread}` : ''}); it may be in a merge queue. Run tower-crane merge ${ctx.task.id} again once it has merged.`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, Math.max(0, deadline - Date.now()))));
    wait = Math.min(wait * 2, POLL_MAX_MS);
  }
}

async function stackMerge(ctx) {
  const { task, project } = ctx;
  const members = ctx.stackTasks || [task];
  if (ctx.args?.admin || project.merge?.admin === true) return fail('stack merges cannot use --admin; unstack first and merge lower tasks individually');
  if (ctx.args?.method && ctx.args.method !== 'merge') return fail('stack merges use merge commits to preserve accepted dependency ancestry');
  // A landed PR is confirmed alone: lower PRs are neither read nor recorded, so they cannot block it.
  const target = await prView(ctx, project.repo, task.pr);
  if (target.error) return fail(target.error);
  if (target.pr.state === 'MERGED') return landed(task, project.repo, target.pr);
  if (task.stack && !task.stack.linked) return fail('stack PR is not linked; run tower-crane stack link before merging');
  if (members.some((t) => t.stack && t.stack.repo !== project.repo)) return fail('stack repository differs from project repo');
  for (const t of members) {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id) && !ctx.stackReports?.[t.id]?.ok)) return fail(`${t.id}: every lower task must be accepted with passing gates`);
  }
  // GitHub can retire the stack object after its queued merge completes.
  const remote = await gh(ctx, ['api', `repos/${project.repo}/stacks?pull_request=${task.pr}`]);
  if (!remote.ok) {
    const unavailable = require('../stack').unavailable(remote);
    return fail(`cannot verify remote stack: ${ghFailure(remote, 'gh api stacks')}${unavailable ? '; ordinary merges enabled; merge lower tasks individually first' : ''}`, { stackUnavailable: unavailable });
  }
  let prs;
  try {
    const data = JSON.parse(remote.stdout);
    prs = require('../stack').numbers(data, task.pr);
  } catch { return fail('cannot read remote stack membership'); }
  if (!prs?.includes(task.pr)) return fail('PR is missing from its remote stack');
  const lower = prs.slice(0, prs.indexOf(task.pr) + 1);
  const known = members.map((t) => t.pr);
  if (lower.some((pr) => !known.includes(pr))) return fail('remote stack has an untracked lower PR; record and accept every lower task before merging');
  const open = [];
  const confirmed = [];
  // Check the whole chain before any merge, then pin each head at GitHub.
  for (const t of members) {
    const before = await prView(ctx, project.repo, t.pr);
    if (before.error) return fail(before.error);
    if (!sameSha(before.pr.headRefOid, t.sha)) return fail(`${t.id}: PR head moved from accepted ${short(t.sha)} to ${short(before.pr.headRefOid)}`);
    if (before.pr.isCrossRepository || before.pr.autoMergeRequest) return fail('stacks require same-repository PRs without auto-merge');
    if (before.pr.state === 'MERGED') { confirmed.push(t.id); continue; }
    if (before.pr.state !== 'OPEN') return fail(`${t.id}: PR is ${before.pr.state}`);
    const retargeted = before.pr.baseRefName === project.base && confirmed.length === members.indexOf(t);
    if (before.pr.baseRefName !== (t.stack?.base || project.base) && !retargeted) return fail(`${t.id}: PR base moved; sync its stack and rerun gates`);
    open.push(t);
  }
  if (ctx.validateStack) {
    const reason = ctx.validateStack();
    if (reason) return fail(reason);
  }
  let m = { ok: true };
  for (const t of open) {
    if (ctx.validateStack) {
      const reason = ctx.validateStack();
      if (reason) { m = fail(reason); break; }
    }
    // Merge commits retain accepted dependency heads as ancestors when upper PRs
    // retarget to main; GitHub keeps lower branches while upper PRs still target them.
    m = await asyncMerge(ctx, t);
    if (!m.ok) break;
    confirmed.push(t.id);
  }
  const mergedTasks = [];
  const failed = [];
  for (const t of members) {
    const after = await prView(ctx, project.repo, t.pr);
    if (!after.error && after.pr.state === 'MERGED' && sameSha(after.pr.headRefOid, t.sha)) {
      mergedTasks.push({ id: t.id, sha: t.sha, revision: t.revision, ref: mergeOid(after.pr),
        summary: `stack merged PR #${t.pr} at ${short(t.sha)}; merge commit ${short(mergeOid(after.pr))}` });
    } else failed.push(after.error || `${t.id}: PR #${t.pr} is ${after.pr.state} or its head moved`);
  }
  return { ok: failed.length === 0, sha: task.sha, ref: mergedTasks.find((t) => t.id === task.id)?.ref,
    mergedTasks,
    summary: failed.length ? `stack merge not confirmed: ${failed.join('; ')}${m.ok ? '' : `; ${m.summary}`}`
      : `merged stack through PR #${task.pr}; ${mergedTasks.length} task(s) confirmed` };
}

async function run(ctx, confirmOnly = false) {
  const { task, project } = ctx;
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  if (task.status !== 'accepted') {
    return fail(`task ${task.id} is ${task.status}, not accepted; merge runs only after tower-crane accept ${task.id} passes`);
  }
  if (!task.pr) return fail(`task ${task.id} has no PR; open one and record it with tower-crane submit ${task.id} --sha SHA --pr N`);
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it with tower-crane submit ${task.id} --sha SHA --pr N`);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  if (ctx.isStacked && !task.stack_disabled) return confirmOnly ? null : stackMerge(ctx);
  if (task.stack && ctx.stackTasks?.some((t) => t.id !== task.id && !ctx.mergedIds?.includes(t.id))) {
    return fail('unstacked fallback waits for every lower task to merge before retargeting this PR');
  }
  const method = args.method || 'squash';
  if (!METHODS.includes(method)) return fail(`--method must be squash, merge or rebase, got ${method}`);
  if (method === 'rebase' && (args.subject !== undefined || args.body !== undefined)) {
    return fail('--subject and --body require --method squash or merge');
  }
  const subject = args.subject ?? task.title;
  const body = args.body ?? task.acceptance.join('\n');
  if (method !== 'rebase' && (typeof subject !== 'string' || !subject.trim())) return fail('--subject must be non-blank');
  const { repo } = project;
  const { pr } = task;
  const sha = task.sha;
  let retargeted;
  const res = (ok, summary, ref) => ({ ok, summary, sha, ...(ref ? { ref } : {}), ...(retargeted ? { retargeted } : {}) });

  const before = await prView(ctx, repo, pr);
  if (before.error) return res(false, before.error);
  const head = before.pr.headRefOid;
  if (before.pr.state === 'MERGED') return landed(task, repo, before.pr);
  // An open PR still needs current gate evidence before any merge or retarget.
  if (confirmOnly) return null;
  if (before.pr.state === 'CLOSED') return res(false, `PR #${pr} in ${repo} is closed; reopen it, or open a new PR and submit it again`);
  if (!sameSha(head, sha)) {
    return res(false, `PR head moved: PR #${pr} head is ${short(head)}, the accepted sha is ${short(sha)}. Push ${short(sha)} back, or submit the new head and take it through the gates again.`);
  }
  if (task.stack_disabled && before.pr.baseRefName !== project.base) {
    const edit = await gh(ctx, ['pr', 'edit', String(pr), '-R', repo, '--base', project.base]);
    if (!edit.ok) return res(false, ghFailure(edit, 'retarget unstacked PR'));
    retargeted = project.base;
  }

  // The full head oid from GitHub: --match-head-commit needs it, and it equals the accepted sha.
  const cmd = ['pr', 'merge', String(pr), '-R', repo, `--${method}`];
  if (!project.merge?.keep_branch) cmd.push('--delete-branch');
  cmd.push('--match-head-commit', head);
  if (method !== 'rebase') cmd.push('--subject', subject, '--body', body);
  if (project.merge?.admin === true) cmd.push('--admin');
  if (ctx.validateStack) {
    const reason = ctx.validateStack();
    if (reason) return res(false, reason);
  }
  log(`merge: gh ${cmd.join(' ')}`);
  const m = await gh(ctx, cmd);
  const after = await prView(ctx, repo, pr);

  if (!after.error && after.pr.state === 'MERGED' && sameSha(after.pr.headRefOid, sha)) {
    const oid = mergeOid(after.pr);
    // gh can merge and then fail to delete the branch; the merge is what this gate records.
    const note = m.ok ? '' : `\ngh reported after merging: ${errText(m)}`;
    return res(true, `merged PR #${pr} into ${project.base || 'the base branch'} in ${repo} (${method}) at ${short(sha)}; merge commit ${short(oid)}${note}`, oid);
  }
  if (!m.ok) {
    return res(false, `gh pr merge refused PR #${pr}: ${m.missing ? 'gh not found on PATH' : errText(m, 10)}\nNothing was retried. Fix what gh names (required checks, reviews, conflicts, a moved head), then run tower-crane merge ${task.id} again.`);
  }
  if (after.error) return res(false, `gh pr merge exited 0, but confirming failed: ${after.error}. Check PR #${pr} before merging again.`);
  return res(false, `gh pr merge exited 0, but PR #${pr} is ${after.pr.state}; it may be in a merge queue or set to auto-merge. Run tower-crane merge ${task.id} again once it has merged.`);
}

// Confirmation shares argument validation and records the same lookup that
// proves the accepted head merged. A null result leaves the gates required.
async function confirm(ctx) {
  const { task, project } = ctx;
  if (!task.pr || !task.sha || !project.repo) return null;
  return run(ctx, true);
}

module.exports = { run, confirm };
