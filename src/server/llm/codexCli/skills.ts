import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** CLI 0.147.0 still discovers host skills with --ignore-user-config. Read names only. */
export function skillPathsToDisable(parent: NodeJS.ProcessEnv): string[] {
  const home = parent.HOME ?? homedir();
  const codexHome = parent.CODEX_HOME ?? path.join(home, '.codex');
  return discoverSkillPaths([path.join(codexHome, 'skills'), path.join(home, '.agents/skills'), '/etc/codex/skills']);
}

export function discoverSkillPaths(roots: string[]): string[] {
  const seen = new Set<string>();
  const skills = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (seen.size > 10_000) throw new Error('Too many skill directories to isolate');
    for (const entry of readdirSync(canonical, { withFileTypes: true })) {
      const file = path.join(canonical, entry.name);
      const stat = entry.isSymbolicLink() ? statSync(file) : entry;
      if (stat.isDirectory()) visit(file);
      else if (entry.name === 'SKILL.md' && stat.isFile()) skills.add(realpathSync(file));
    }
  };
  for (const root of roots) visit(root);
  return [...skills].sort();
}
