// Build script with optional esbuild bundling and safe fallback to tsc
// - Bundles src/extension.ts to out/extension.js when esbuild is available
// - Copies webview assets and icon
// - Keeps native deps external (e.g., sqlite3)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'out');
const webviewSrc = join(root, 'src', 'webview');
const webviewOut = join(outDir, 'webview');
const iconSrc = join(root, 'assets', 'icon.png');
const iconOut = join(webviewOut, 'assets', 'icon.png');

async function bundleWithEsbuild() {
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [join(root, 'src', 'extension.ts')],
      outfile: join(outDir, 'extension.js'),
      platform: 'node',
      target: 'node16',
      bundle: true,
      minify: true,
      sourcemap: false,
      external: ['vscode', 'sqlite3', 'fs', 'path', 'os', 'child_process'],
      loader: { '.ts': 'ts' },
      logLevel: 'info',
    });
    return true;
  } catch (err) {
    console.warn('[build] esbuild not available, falling back to tsc. Reason:', err?.message || err);
    return false;
  }
}

function compileWithTsc() {
  const res = spawnSync('npx', ['tsc', '-p', './'], { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function copyWebview() {
  if (existsSync(webviewSrc)) {
    mkdirSync(webviewOut, { recursive: true });
    cpSync(webviewSrc, webviewOut, { recursive: true });
  }
  // ensure icon packaged with webview
  if (existsSync(iconSrc)) {
    mkdirSync(join(webviewOut, 'assets'), { recursive: true });
    cpSync(iconSrc, iconOut);
  }
}

(async () => {
  const bundled = await bundleWithEsbuild();
  if (!bundled) {
    compileWithTsc();
  }
  copyWebview();
})();

