/* Submission bodies for the submit route (E3 design 4.4) with whether the service accepts each. SUBMISSION_SHAPES are
   the shapes app.submission_fields (003_content.sql) refuses or accepts, and the service must agree with the routine on
   every one: tests/e3/unit/candidates.test.mjs runs them through the service, tests/e3/stack/routes.test.mjs through
   the routine itself. TRIMMED_SHAPES are the three shapes of E3A-R-D1: the service trims each display name and refuses
   a whitespace-only one, and since migration 004 the routine trims with the same class, so both agree on them too;
   before 004 the routine read them untrimmed and disagreed on all three. Not a test file; shared by both. */
import { cp } from './helpers.mjs';

export const SUBMISSION = Object.freeze({
  sourcePlatform: 'claude_code',
  confidence: 'high',
  permittedData: 'Internal weekly reports, no client names',
});
const MEMBERSHIP = '3b6e2c4d-5f70-4b9c-8d1e-2f3a4b5c6d7e';
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

export const SUBMISSION_SHAPES = Object.freeze([
  ['the three required fields', { ...SUBMISSION }, true],
  ['every field', { ...SUBMISSION, dependencies: ['a'], declaredContributors: [{ membershipId: MEMBERSHIP }] }, true],
  ['empty lists', { ...SUBMISSION, dependencies: [], declaredContributors: [] }, true],
  ['source platform of 80 astral characters', { ...SUBMISSION, sourcePlatform: cp(0x1f600).repeat(80) }, true],
  ['source platform of 81 characters', { ...SUBMISSION, sourcePlatform: 'x'.repeat(81) }, false],
  ['empty source platform', { ...SUBMISSION, sourcePlatform: '' }, false],
  ['missing source platform', { confidence: 'high', permittedData: 'x' }, false],
  ['numeric source platform', { ...SUBMISSION, sourcePlatform: 7 }, false],
  ['confidence outside the vocabulary', { ...SUBMISSION, confidence: 'certain' }, false],
  ['confidence in capitals', { ...SUBMISSION, confidence: 'HIGH' }, false],
  ['missing confidence', { sourcePlatform: 'x', permittedData: 'x' }, false],
  ['medium confidence', { ...SUBMISSION, confidence: 'medium' }, true],
  ['low confidence', { ...SUBMISSION, confidence: 'low' }, true],
  ['permitted data of 2000 characters', { ...SUBMISSION, permittedData: 'p'.repeat(2000) }, true],
  ['permitted data of 2001 characters', { ...SUBMISSION, permittedData: 'p'.repeat(2001) }, false],
  ['40 dependencies', { ...SUBMISSION, dependencies: many(40, (i) => `d${i}`) }, true],
  ['41 dependencies', { ...SUBMISSION, dependencies: many(41, (i) => `d${i}`) }, false],
  ['a dependency of 200 characters', { ...SUBMISSION, dependencies: ['d'.repeat(200)] }, true],
  ['a dependency of 201 characters', { ...SUBMISSION, dependencies: ['d'.repeat(201)] }, false],
  ['an empty dependency', { ...SUBMISSION, dependencies: [''] }, false],
  ['a numeric dependency', { ...SUBMISSION, dependencies: [1] }, false],
  ['dependencies null', { ...SUBMISSION, dependencies: null }, false],
  ['dependencies not a list', { ...SUBMISSION, dependencies: 'a' }, false],
  ['50 declarations', { ...SUBMISSION, declaredContributors: many(50, () => ({ displayName: 'n' })) }, true],
  ['51 declarations', { ...SUBMISSION, declaredContributors: many(51, () => ({ displayName: 'n' })) }, false],
  ['declarations null', { ...SUBMISSION, declaredContributors: null }, false],
  [
    'a declaration holding both keys',
    { ...SUBMISSION, declaredContributors: [{ membershipId: MEMBERSHIP, displayName: 'x' }] },
    false,
  ],
  ['an empty declaration', { ...SUBMISSION, declaredContributors: [{}] }, false],
  ['a declaration with a typo key', { ...SUBMISSION, declaredContributors: [{ membershipID: MEMBERSHIP }] }, false],
  ['a declaration that is a list', { ...SUBMISSION, declaredContributors: [[MEMBERSHIP]] }, false],
  ['a null membership', { ...SUBMISSION, declaredContributors: [{ membershipId: null }] }, false],
  ['an uppercase membership', { ...SUBMISSION, declaredContributors: [{ membershipId: MEMBERSHIP.toUpperCase() }] }, false],
  ['a membership that is not a uuid', { ...SUBMISSION, declaredContributors: [{ membershipId: 'm1' }] }, false],
  ['a numeric name', { ...SUBMISSION, declaredContributors: [{ displayName: 123 }] }, false],
  ['a null name', { ...SUBMISSION, declaredContributors: [{ displayName: null }] }, false],
  ['an empty name', { ...SUBMISSION, declaredContributors: [{ displayName: '' }] }, false],
  ['a name of 120 astral characters', { ...SUBMISSION, declaredContributors: [{ displayName: cp(0x1f600).repeat(120) }] }, true],
  ['a name of 121 characters', { ...SUBMISSION, declaredContributors: [{ displayName: 'n'.repeat(121) }] }, false],
  ['NUL in the source platform', { ...SUBMISSION, sourcePlatform: `a${cp(0)}b` }, false],
  ['a lone surrogate in permitted data', { ...SUBMISSION, permittedData: `a${String.fromCharCode(0xd800)}b` }, false],
  ['an unknown key', { ...SUBMISSION, contentSha256: 'a'.repeat(64) }, false],
  ['a snake_case key', { ...SUBMISSION, source_platform: 'x' }, false],
]);

export const TRIMMED_SHAPES = Object.freeze([
  ['a whitespace-only name', { ...SUBMISSION, declaredContributors: [{ displayName: '   ' }] }, false],
  ['a tab and newline name', { ...SUBMISSION, declaredContributors: [{ displayName: `${cp(0x09)}${cp(0x0a)}` }] }, false],
  [
    'a name of 120 characters inside spaces',
    { ...SUBMISSION, declaredContributors: [{ displayName: ` ${'n'.repeat(120)} ` }] },
    true,
  ],
]);
