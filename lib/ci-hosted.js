'use strict';

const { isDeepStrictEqual } = require('node:util');

function resolve(project) {
  const ci = project.ci ?? {};
  const ignoreHint = 'project.json ci.ignore_apps must be an array of GitHub app slugs; set it with tower-crane project set --ci-ignore-apps \'["claude"]\', or use --ci-ignore-apps null to check every app';
  if (typeof ci !== 'object' || Array.isArray(ci)) return { error: ignoreHint };
  const ignore = ci.ignore_apps ?? [];
  if (!Array.isArray(ignore) || !ignore.every((app) => typeof app === 'string' && app.trim())) return { error: ignoreHint };
  const required = ci.required ?? [];
  if (!Array.isArray(required) || !required.every((name) => typeof name === 'string' && name.trim())) {
    return { error: 'project.json ci.required must be an array of non-blank strings naming required check runs or prefixes; set it with tower-crane project set --ci-required JSON' };
  }
  const rules = ci.capped_review ?? [];
  try {
    if (!Array.isArray(rules)) throw new Error('invalid capped review rules');
    for (const rule of rules) {
      if (!rule || typeof rule.app !== 'string' || !rule.app.trim() || rule.app !== rule.app.trim()
        || typeof rule.pattern !== 'string' || !rule.pattern.trim()) throw new Error('invalid capped review rule');
      new RegExp(rule.pattern, 'i');
    }
  } catch {
    return { error: 'project.json ci.capped_review must be an array of {app, pattern} with a nonempty GitHub app slug without surrounding whitespace and a valid nonempty regular expression' };
  }
  return {
    policy: {
      required: [...required],
      ignore_apps: [...ignore],
      capped_review: rules.map((rule) => ({ app: rule.app, pattern: rule.pattern })),
    },
  };
}

function mismatch(recorded, project, taskId) {
  const current = resolve(project);
  if (current.error) return current.error;
  if (!isDeepStrictEqual(recorded, current.policy)) {
    return `hosted CI evidence policy is missing or no longer matches the current project; run tower-crane check ci ${taskId} again`;
  }
  return null;
}

module.exports = { resolve, mismatch };
