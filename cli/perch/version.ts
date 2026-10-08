// Which Perch this install is (plans/app-versioning.md): the root
// package.json's version, the one every manifest follows, and the commit
// checked out.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR } from './paths.ts';
import { output } from './run.ts';

export function installedVersion(): { version: string; commit: string } {
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8')).version ?? version;
  } catch {
    // A broken checkout; doctor says more.
  }
  const commit = output('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD']);
  return { version, commit };
}

/** "0.2.0 (3e0ad42)", or just the version outside a git checkout. */
export function versionLine(): string {
  const { version, commit } = installedVersion();
  return commit ? `${version} (${commit})` : version;
}

export const cmdVersion = () => console.log(`perch ${versionLine()}`);
