'use strict';

const DEFAULT_MIN_SOURCES = 10;

function errors(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['research must be an object'];
  const errs = Object.keys(value).filter(k => k !== 'min_sources').map(k => `research: unknown field ${k}`);
  if (value.min_sources !== undefined && (!Number.isSafeInteger(value.min_sources) || value.min_sources < 1)) {
    errs.push('research.min_sources must be a positive integer');
  }
  return errs;
}

const minimum = project => project.research?.min_sources ?? DEFAULT_MIN_SOURCES;
const deliverable = task => `research/${task.id}.json`;
const required = task => task.kind === 'research' && (task.tier === undefined || task.tier === 'research');

module.exports = { DEFAULT_MIN_SOURCES, errors, minimum, deliverable, required };
