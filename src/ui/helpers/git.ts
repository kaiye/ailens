import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

export async function getGitInfo(workspacePath: string): Promise<any> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: workspacePath });

    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
      const remoteUrl = stdout.trim();
      if (remoteUrl) {
        return { hasGit: true, remoteUrl, displayUrl: remoteUrl };
      }
    } catch {
      return { hasGit: true, remoteUrl: null, displayUrl: 'Local repository (no remote)' };
    }

    return { hasGit: true, remoteUrl: null, displayUrl: 'Local repository (no remote)' };
  } catch {
    return null;
  }
}

export function formatGitUrl(url: string): string {
  if (!url) return 'No remote URL';
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) return `${match[1]}/${match[2]}`;
  return url;
}

