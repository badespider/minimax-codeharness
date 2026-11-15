import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const installer = join(root, 'scripts', 'install-auto-workflow.mjs');
const tempRoot = resolve(tmpdir());
const fixture = resolve(mkdtempSync(join(tempRoot, 'minimax-auto-workflow-')));
after(() => {
  if (dirname(fixture) !== tempRoot || !basename(fixture).startsWith('minimax-auto-workflow-')) {
    throw new Error('Refusing to remove a fixture outside the expected temporary directory.');
  }
  rmSync(fixture, { recursive: true, force: true });
});

function run(args = [], overrides = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: fixture,
    env: { ...process.env, MINIMAX_DATA_DIR: '', MAVIS_DATA_DIR: '', ...overrides },
    encoding: 'utf8',
  });
}

test('installs profile instructions and all skills; repeated install preserves files', () => {
  const profile = join(fixture, 'profile with spaces');
  const first = run(['--data-dir', profile]);
  assert.equal(first.status, 0, first.stderr);
  const template = readFileSync(join(root, 'assets', 'auto-workflow', 'auto-instructions.md'));
  assert.deepEqual(readFileSync(join(profile, 'AGENTS.md')), template);
  for (const name of ['verify-project', 'correct-repeated-failures', 'interrogate-change', 'model-project-state']) {
    assert.deepEqual(readFileSync(join(profile, 'skills', name, 'SKILL.md')), readFileSync(join(root, 'assets', 'auto-workflow', 'skills', name, 'SKILL.md')));
  }
  const again = run(['--data-dir', profile]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already installed/);
});

test('conflicting personal instructions refuse the entire install without exposing contents', () => {
  const profile = join(fixture, 'personal-profile');
  mkdirSync(profile);
  const personal = 'Private existing instructions: do not disclose this text.\n';
  writeFileSync(join(profile, 'AGENTS.md'), personal);
  const result = run(['--data-dir', profile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Conflict:/);
  assert.match(result.stderr, /No changes made/);
  assert.doesNotMatch(result.stderr + result.stdout, /Private existing instructions/);
  assert.equal(readFileSync(join(profile, 'AGENTS.md'), 'utf8'), personal);
  assert.throws(() => readFileSync(join(profile, 'skills', 'verify-project', 'SKILL.md')), { code: 'ENOENT' });
});

test('conflicting skill does not overwrite it or create other files', () => {
  const profile = join(fixture, 'custom-skill-profile');
  const custom = join(profile, 'skills', 'interrogate-change');
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, 'SKILL.md'), 'Personal custom skill\n');
  const result = run(['--data-dir', profile]);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(custom, 'SKILL.md'), 'utf8'), 'Personal custom skill\n');
  assert.throws(() => readFileSync(join(profile, 'AGENTS.md')), { code: 'ENOENT' });
});

test('skills-only leaves existing personal instructions intact and is repeatable', () => {
  const profile = join(fixture, 'skills-only-profile');
  mkdirSync(profile);
  const personal = 'Existing personal instructions\n';
  writeFileSync(join(profile, 'AGENTS.md'), personal);
  for (let n = 0; n < 2; n += 1) {
    const result = run(['--skills-only', '--data-dir', profile]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Merge the instruction template/);
    assert.equal(readFileSync(join(profile, 'AGENTS.md'), 'utf8'), personal);
    assert.ok(readFileSync(join(profile, 'skills', 'verify-project', 'SKILL.md')).length);
  }
});

test('profile resolution honors command-line override, then MiniMax and legacy environment', () => {
  const explicit = join(fixture, 'explicit');
  const preferred = join(fixture, 'preferred');
  const legacy = join(fixture, 'legacy');
  assert.equal(run(['--data-dir', explicit], { MINIMAX_DATA_DIR: preferred, MAVIS_DATA_DIR: legacy }).status, 0);
  assert.equal(run([], { MINIMAX_DATA_DIR: preferred, MAVIS_DATA_DIR: legacy }).status, 0);
  assert.equal(run([], { MAVIS_DATA_DIR: legacy }).status, 0);
  for (const profile of [explicit, preferred, legacy]) assert.ok(readFileSync(join(profile, 'AGENTS.md')).length);
});

test('refuses to follow a linked skills directory', () => {
  const outside = join(fixture, 'outside');
  const profile = join(fixture, 'linked-profile');
  mkdirSync(outside); mkdirSync(profile);
  symlinkSync(outside, join(profile, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(['--data-dir', profile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ordinary directory/);
  assert.throws(() => readFileSync(join(profile, 'AGENTS.md')), { code: 'ENOENT' });
  assert.throws(() => readFileSync(join(outside, 'verify-project', 'SKILL.md')), { code: 'ENOENT' });
});
