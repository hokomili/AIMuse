import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(workspace, 'native');
const buildRuntimeBinaries = process.platform === 'win32' || process.platform === 'darwin';
const architectureArgument = process.argv.find((value) => value.startsWith('--arch='));
const requestedArchitecture = architectureArgument?.slice('--arch='.length) || process.env.AIMUSE_TARGET_ARCH || process.arch;
const supportedArchitectures = process.platform === 'darwin' ? ['arm64', 'x64', 'universal'] : process.platform === 'win32' ? ['x64'] : [process.arch];
if (!supportedArchitectures.includes(requestedArchitecture)) {
  throw new Error(`Native ${process.platform} builds support ${supportedArchitectures.join(', ')}, received ${requestedArchitecture}.`);
}
const cmakeArchitecture = requestedArchitecture === 'universal' ? 'arm64;x86_64' : requestedArchitecture === 'x64' ? 'x86_64' : requestedArchitecture;
const build = process.env.AIMUSE_NATIVE_BUILD_DIR
  ? resolve(process.env.AIMUSE_NATIVE_BUILD_DIR)
  : join(source, process.platform === 'win32' ? 'build' : `build-${process.platform}-${requestedArchitecture}`);
const distribution = process.env.AIMUSE_NATIVE_DIST_DIR
  ? resolve(process.env.AIMUSE_NATIVE_DIST_DIR)
  : join(source, 'dist', 'native');
const action = process.argv[2] ?? 'build';
const enableWasapi = process.platform === 'win32' && process.env.AIMUSE_ENABLE_WASAPI !== '0';
const enableCoreAudio = process.platform === 'darwin' && process.env.AIMUSE_ENABLE_COREAUDIO !== '0';
const fetchAudioDependencies = enableWasapi || enableCoreAudio;

function executable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return candidates.at(-1);
}

const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
const cmake = executable([
  process.env.AIMUSE_CMAKE,
  join(programFiles, 'CMake', 'bin', 'cmake.exe'),
  join(programFiles, 'Microsoft Visual Studio', '18', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
  join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
  process.platform === 'win32' ? 'cmake.exe' : 'cmake',
]);
const ninja = executable([
  process.env.AIMUSE_NINJA,
  join(programFiles, 'Microsoft Visual Studio', '18', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', 'ninja.exe'),
  join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', 'ninja.exe'),
  process.platform === 'win32' ? 'ninja.exe' : 'ninja',
]);
const make = process.platform === 'win32' ? undefined : executable([process.env.AIMUSE_MAKE, 'make']);
const ctest = join(dirname(cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest');

function run(program, arguments_) {
  const result = spawnSync(program, arguments_, { cwd: workspace, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function configure() {
  const arguments_ = [
    '--fresh', '-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
    `-DAIMUSE_FETCH_AUDIO_DEPS=${fetchAudioDependencies ? 'ON' : 'OFF'}`,
    `-DAIMUSE_ENABLE_WASAPI=${enableWasapi ? 'ON' : 'OFF'}`,
    `-DAIMUSE_ENABLE_COREAUDIO=${enableCoreAudio ? 'ON' : 'OFF'}`,
    `-DAIMUSE_BUILD_RUNTIME_BINARIES=${buildRuntimeBinaries ? 'ON' : 'OFF'}`,
    '-DAIMUSE_ENABLE_PLUGIN_SDKS=OFF',
    '-DAIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER=OFF',
    ...(process.env.AIMUSE_MINIAUDIO_SOURCE_DIR ? [`-DFETCHCONTENT_SOURCE_DIR_MINIAUDIO=${resolve(process.env.AIMUSE_MINIAUDIO_SOURCE_DIR)}`] : []),
  ];
  if (process.platform === 'win32') {
    const defaultGenerator = cmake.includes('\\18\\') ? 'Visual Studio 18 2026' : 'Visual Studio 17 2022';
    arguments_.push('-G', process.env.AIMUSE_CMAKE_GENERATOR ?? defaultGenerator, '-A', 'x64');
  } else if (ninja && existsSync(ninja)) {
    arguments_.push('-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`);
  } else if (make) {
    arguments_.push('-G', 'Unix Makefiles', `-DCMAKE_MAKE_PROGRAM=${make}`);
  }
  if (process.platform === 'darwin') arguments_.push(`-DCMAKE_OSX_ARCHITECTURES=${cmakeArchitecture}`);
  run(cmake, arguments_);
}

function hasExpectedConfiguration() {
  const cachePath = join(build, 'CMakeCache.txt');
  if (!existsSync(cachePath) || (!existsSync(join(build, 'build.ninja')) && !existsSync(join(build, 'Makefile')) && !existsSync(join(build, 'ALL_BUILD.vcxproj')))) return false;
  const cache = readFileSync(cachePath, 'utf8');
  return cache.includes(`AIMUSE_FETCH_AUDIO_DEPS:BOOL=${fetchAudioDependencies ? 'ON' : 'OFF'}`) &&
    cache.includes(`AIMUSE_ENABLE_WASAPI:BOOL=${enableWasapi ? 'ON' : 'OFF'}`) &&
    cache.includes(`AIMUSE_ENABLE_COREAUDIO:BOOL=${enableCoreAudio ? 'ON' : 'OFF'}`) &&
    cache.includes(`AIMUSE_BUILD_RUNTIME_BINARIES:BOOL=${buildRuntimeBinaries ? 'ON' : 'OFF'}`) &&
    cache.includes('AIMUSE_ENABLE_PLUGIN_SDKS:BOOL=OFF') &&
    cache.includes('AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER:BOOL=OFF') &&
    (!process.env.AIMUSE_MINIAUDIO_SOURCE_DIR || cache.includes(`FETCHCONTENT_SOURCE_DIR_MINIAUDIO:UNINITIALIZED=${resolve(process.env.AIMUSE_MINIAUDIO_SOURCE_DIR)}`)) &&
    (process.platform !== 'darwin' || cache.includes(`CMAKE_OSX_ARCHITECTURES:STRING=${cmakeArchitecture}`));
}

function stageRuntime() {
  if (!buildRuntimeBinaries) return;
  mkdirSync(distribution, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['aimuse-audio', 'aimuse-plugin-scanner', 'aimuse-plugin-bridge']) {
    const input = join(build, `${name}${suffix}`);
    if (!existsSync(input)) throw new Error(`Native runtime output is missing: ${input}`);
    copyFileSync(input, join(distribution, `${name}${suffix}`));
  }
}

if (!['configure', 'build', 'test', 'plan'].includes(action)) {
  console.error('usage: node scripts/native-build.mjs [configure|build|test|plan] [--arch=arm64|x64|universal]');
  process.exit(2);
}
if (action === 'plan') {
  process.stdout.write(`${JSON.stringify({ platform: process.platform, hostArchitecture: process.arch, requestedArchitecture, cmakeArchitecture, build, distribution }, null, 2)}\n`);
}
if (action === 'configure') configure();
if (action === 'build' || action === 'test') {
  if (!hasExpectedConfiguration()) configure();
  run(cmake, ['--build', build, '--config', 'RelWithDebInfo', '--parallel']);
  stageRuntime();
}
if (action === 'test') run(ctest, ['--test-dir', build, '-C', 'RelWithDebInfo', '--output-on-failure']);
