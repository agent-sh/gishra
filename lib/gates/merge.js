'use strict';
// Gate `merge ID`: merges an accepted task's PR only while its head is still the accepted
// commit, then confirms on GitHub that it merged. A refused merge is reported, never retried.
const { fail, short, gh, ghFailure, errText, sameSha } = require('./common');

const METHODS = ['squash', 'merge', 'rebase'];

async function prView(ctx, repo, pr) {
  const r = await gh(ctx, ['pr', 'view', String(pr), '-R', repo, '--json', 'state,headRefOid,mergeCommit']);
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
  const res = (ok, summary, ref) => ({ ok, summary, sha, ...(ref ? { ref } : {}) });

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

  // The full head oid from GitHub: --match-head-commit needs it, and it equals the accepted sha.
  const cmd = ['pr', 'merge', String(pr), '-R', repo, `--${method}`];
  if (!project.merge?.keep_branch) cmd.push('--delete-branch');
  cmd.push('--match-head-commit', head);
  if (method !== 'rebase') cmd.push('--subject', subject, '--body', body);
  if (project.merge?.admin === true) cmd.push('--admin');
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
