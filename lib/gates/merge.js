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

async function stackMerge(ctx) {
  const { task, project } = ctx;
  const members = ctx.stackTasks || [task];
  if (ctx.args?.admin) return fail('stack merges cannot use --admin; unstack first and merge lower tasks individually');
  if (ctx.args?.method && ctx.args.method !== 'squash') return fail('stack merges use squash');
  if (task.stack && !task.stack.linked) return fail('stack PR is not linked; run tower-crane stack link before merging');
  if (members.some((t) => t.stack && t.stack.repo !== project.repo)) return fail('stack repository differs from project repo');
  for (const t of members) {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id) && !ctx.stackReports?.[t.id]?.ok)) return fail(`${t.id}: every lower task must be accepted with passing gates`);
  }
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
  // Re-read all heads immediately before merging: stack merge has no match-head option.
  for (const t of members) {
    const before = await prView(ctx, project.repo, t.pr);
    if (before.error) return fail(before.error);
    if (!sameSha(before.pr.headRefOid, t.sha)) return fail(`${t.id}: PR head moved from accepted ${short(t.sha)} to ${short(before.pr.headRefOid)}`);
    if (before.pr.isCrossRepository || before.pr.autoMergeRequest) return fail('stacks require same-repository PRs without auto-merge');
    if (before.pr.state === 'MERGED') continue;
    if (before.pr.state !== 'OPEN') return fail(`${t.id}: PR is ${before.pr.state}`);
    if (before.pr.baseRefName !== (t.stack?.base || project.base)) return fail(`${t.id}: PR base moved; sync its stack and rerun gates`);
    open.push(t);
  }
  if (ctx.validateStack) {
    const reason = ctx.validateStack();
    if (reason) return fail(reason);
  }
  let m = { ok: true };
  if (open.length) {
    const cmd = ['stack', 'merge', String(task.pr), '--yes', '--squash'];
    ctx.log?.(`merge: gh ${cmd.join(' ')}`);
    m = await gh(ctx, cmd);
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
    mergedTasks, stackUnavailable: !m.ok && require('../stack').unavailable(m),
    summary: failed.length ? `stack merge not confirmed: ${failed.join('; ')}${m.ok ? '' : `; ${errText(m)}`}${m.status === 9 ? '; ordinary merges enabled; merge lower tasks individually first' : ''}`
      : `merged stack through PR #${task.pr}; ${mergedTasks.length} task(s) confirmed${m.ok ? '' : `; gh reported ${errText(m)}`}` };
}

async function run(ctx) {
  const { task, project } = ctx;
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  if (task.status !== 'accepted') {
    return fail(`task ${task.id} is ${task.status}, not accepted; merge runs only after tower-crane accept ${task.id} passes`);
  }
  if (!task.pr) return fail(`task ${task.id} has no PR; open one and record it with tower-crane submit ${task.id} --sha SHA --pr N`);
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it with tower-crane submit ${task.id} --sha SHA --pr N`);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  if (ctx.isStacked && !task.stack_disabled) return stackMerge(ctx);
  if (task.stack && ctx.stackTasks?.some((t) => t.id !== task.id && !ctx.mergedIds?.includes(t.id))) {
    return fail('unstacked fallback waits for every lower task to merge before retargeting this PR');
  }
  const method = args.method || 'squash';
  if (!METHODS.includes(method)) return fail(`--method must be squash, merge or rebase, got ${method}`);
  const { repo } = project;
  const { pr } = task;
  const sha = task.sha;
  let retargeted;
  const res = (ok, summary, ref) => ({ ok, summary, sha, ...(ref ? { ref } : {}), ...(retargeted ? { retargeted } : {}) });

  const before = await prView(ctx, repo, pr);
  if (before.error) return res(false, before.error);
  const head = before.pr.headRefOid;
  if (before.pr.state === 'MERGED') {
    if (sameSha(head, sha)) return res(true, `PR #${pr} in ${repo} was already merged at ${short(sha)}; merge commit ${short(mergeOid(before.pr))}`, mergeOid(before.pr));
    return res(false, `PR #${pr} in ${repo} was merged with head ${short(head)}, not the accepted ${short(sha)}; the merged code was not the accepted code, so review what landed`);
  }
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
  const cmd = ['pr', 'merge', String(pr), '-R', repo, `--${method}`, '--delete-branch', '--match-head-commit', head];
  if (args.admin) cmd.push('--admin');
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

module.exports = { run };
