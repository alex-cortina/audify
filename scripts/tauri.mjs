// Runs the Tauri CLI with CMake and Ninja available. The Opus decoder (libopus) is built
// with CMake. Ninja matters too: with Visual Studio project files instead, the Rust cmake
// crate drops the optimization flags and libopus decodes about 2.5x slower.
// If they are not on PATH, use the copies in Visual Studio's "C++ CMake tools" component.
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const env = { ...process.env };
const has = (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore', shell: true }).status === 0;
if (!(has('cmake') && has('ninja')) && process.platform === 'win32') {
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  try {
    const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
    const cmake = join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
    const ninja = join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja');
    if (existsSync(cmake)) {
      env.CMAKE = cmake;
      env.PATH = [dirname(cmake), ninja, env.PATH].join(delimiter);
    }
  } catch { /* no Visual Studio; the build will say CMake is missing */ }
}
const r = spawnSync('npx', ['tauri', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
