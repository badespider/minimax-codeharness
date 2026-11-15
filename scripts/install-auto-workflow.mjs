#!/usr/bin/env node

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'assets', 'auto-workflow');
const names = ['verify-project', 'correct-repeated-failures', 'interrogate-change', 'model-project-state'];

function usage() {
  return 'Usage: node scripts/install-auto-workflow.mjs [--data-dir PATH] [--skills-only]';
}

function options(args, env = process.env) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return undefined;
  let override;
  let skillsOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--data-dir' && override === undefined && args[i + 1]?.trim() && !args[i + 1].startsWith('--')) override = args[++i].trim();
    else if (args[i] === '--skills-only' && !skillsOnly) skillsOnly = true;
    else throw new Error(usage());
  }
  const selected = override || env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim() || join(homedir(), '.minimax');
  return { target: isAbsolute(selected) ? selected : resolve(selected), skillsOnly };
}

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function assertDirectoryOrMissing(path) {
  const stat = await inspect(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Expected an ordinary directory (not a link): ${path}`);
  }
}

async function install(target, skillsOnly) {
  const sources = [
    ...(!skillsOnly ? [{ from: join(source, 'auto-instructions.md'), to: join(target, 'AGENTS.md') }] : []),
    ...names.map((name) => ({ from: join(source, 'skills', name, 'SKILL.md'), to: join(target, 'skills', name, 'SKILL.md') })),
  ];
  // Do not follow an existing link under the profile while adding files.
  await assertDirectoryOrMissing(target);
  await assertDirectoryOrMissing(join(target, 'skills'));
  for (const name of names) await assertDirectoryOrMissing(join(target, 'skills', name));

  const conflicts = [];
  const pending = [];
  for (const entry of sources) {
    const bytes = await readFile(entry.from);
    if (basename(entry.to) === 'AGENTS.md' && bytes.length > 32 * 1024) {
      throw new Error('Auto workflow instructions exceed the MiniMax global instruction size limit.');
    }
    const existing = await inspect(entry.to);
    if (!existing) pending.push({ ...entry, bytes });
    else if (!existing.isFile() || existing.isSymbolicLink() || !(await readFile(entry.to)).equals(bytes)) conflicts.push(entry);
  }
  if (conflicts.length) {
    for (const entry of conflicts) {
      console.error(`Conflict: ${entry.to}\n  Template: ${entry.from}`);
    }
    throw new Error('No changes made. Review the templates and merge or install them manually; existing files were preserved.');
  }

  for (const entry of pending) {
    await mkdir(dirname(entry.to), { recursive: true });
    // Exclusive creation preserves a file created after the preflight check.
    await writeFile(entry.to, entry.bytes, { flag: 'wx' });
    console.log(`Installed: ${entry.to}`);
  }
  if (skillsOnly) console.log('Skills installed or already present. Merge the instruction template into your profile AGENTS.md separately, then restart MiniMax.');
  else console.log(pending.length ? 'Auto workflow installed. Restart MiniMax to load it.' : 'Auto workflow is already installed; no changes made.');
}

try {
  const parsed = options(process.argv.slice(2));
  if (!parsed) console.log(usage());
  else await install(parsed.target, parsed.skillsOnly);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Auto workflow installation failed.');
  process.exitCode = 1;
}
