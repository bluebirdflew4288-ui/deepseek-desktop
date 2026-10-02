/** Keep Electron's Node selection local to each owned Node invocation. */

// This preload runs only inside Electron Node children, never the Desktop main process.
// Explicit arguments survive Harness runner environment scrubbing; NODE_OPTIONS does not.
const bootstrap = String.raw`
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
if (process.versions.electron) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const preload = '--import=' + import.meta.url;
  const prepend = args => args.includes(preload) ? [...args] : [preload, ...args];
  const environment = env => ({ ...(env ?? process.env), ELECTRON_RUN_AS_NODE: '1' });
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    const prepare = parameters => {
      const [file, ...rest] = parameters;
      const args = Array.isArray(rest[0]) ? rest.shift() : [];
      while (rest[0] === undefined && rest.length) rest.shift();
      const first = rest[0];
      const options = first !== null && typeof first === 'object' ? rest.shift()
        : typeof first === 'string' && name.startsWith('execFile') ? { encoding: rest.shift() } : {};
      const executable = name === 'fork' ? options.execPath ?? process.execPath : file;
      if (executable !== process.execPath || options.shell) return parameters;
      const owned = { ...options, env: environment(options.env) };
      if (name === 'fork') owned.execArgv = prepend(options.execArgv ?? process.execArgv);
      return [file, name === 'fork' ? args : prepend(args), owned, ...rest];
    };
    const wrapped = function (...parameters) { return Reflect.apply(original, this, prepare(parameters)); };
    const custom = original[promisify.custom];
    if (custom) wrapped[promisify.custom] = function (...parameters) {
      return Reflect.apply(custom, this, prepare(parameters));
    };
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
}
`

/**
 * Preload that clears Node selection before task code and restores it for self-spawned Node children.
 * External executables and explicit shell commands retain their normal environment and launch mode.
 * @returns Relocatable Node import argument, also safe inside Windows command files.
 */
export function electronNodeBootstrapArgument(): string {
  return `--import=data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`
}
