/**
 * Package-manager detection and command translation.
 *
 * Finds which JavaScript and Python package managers a project uses (from
 * `packageManager` in package.json, lockfiles, and pyproject sections),
 * recognises dependency-changing commands run with a different manager, and
 * translates them to the project's manager.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type JsManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type PyManager = 'uv' | 'poetry' | 'pipenv' | 'pdm' | 'pip'

/** What a directory tree says about its package managers. */
export interface ProjectManagers {
  js?: { manager: JsManager; evidence: string; dir: string }
  py?: { manager: PyManager; evidence: string; dir: string }
}

const JS_LOCKS: Array<[string, JsManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

const PY_LOCKS: Array<[string, PyManager]> = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['pdm.lock', 'pdm'],
  ['Pipfile', 'pipenv'],
  ['Pipfile.lock', 'pipenv'],
]

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Missing or unreadable manifests carry no evidence.
    return undefined
  }
}

/**
 * Detect the JavaScript manager for `dir`, walking up to `stopAt`.
 * @param dir - starting directory.
 * @param stopAt - directory where the walk stops (inclusive), usually the workspace root.
 * @returns the manager with its evidence, or undefined.
 */
export function detectJs(dir: string, stopAt: string): ProjectManagers['js'] {
  for (const d of ancestors(dir, stopAt)) {
    const pkg = readText(join(d, 'package.json'))
    if (pkg !== undefined) {
      const m = /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(pkg)
      if (m !== null) return { manager: m[1] as JsManager, evidence: `"packageManager": "${m[1]}@…" in ${join(d, 'package.json')}`, dir: d }
    }
    const locks = JS_LOCKS.filter(([file]) => existsSync(join(d, file)))
    const managers = new Set(locks.map(([, m]) => m))
    if (managers.size === 1) return { manager: locks[0]![1], evidence: `${locks[0]![0]} in ${d}`, dir: d }
    // Several different lockfiles: ambiguous, do not guess.
    if (managers.size > 1) return undefined
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return { manager: 'pnpm', evidence: `pnpm-workspace.yaml in ${d}`, dir: d }
  }
  return undefined
}

/**
 * Detect the Python manager for `dir`, walking up to `stopAt`.
 * @param dir - starting directory.
 * @param stopAt - directory where the walk stops.
 * @returns the manager with its evidence, or undefined.
 */
export function detectPy(dir: string, stopAt: string): ProjectManagers['py'] {
  for (const d of ancestors(dir, stopAt)) {
    const locks = PY_LOCKS.filter(([file]) => existsSync(join(d, file)))
    const managers = new Set(locks.map(([, m]) => m))
    if (managers.size === 1) return { manager: locks[0]![1], evidence: `${locks[0]![0]} in ${d}`, dir: d }
    // Several different lockfiles: ambiguous, do not guess.
    if (managers.size > 1) return undefined
    const pyproject = readText(join(d, 'pyproject.toml'))
    if (pyproject !== undefined) {
      const pyTools: Array<[RegExp, PyManager, string]> = [
        [/^\s*\[tool\.poetry(?:\]|\.)/m, 'poetry', '[tool.poetry]'],
        [/^\s*\[tool\.uv(?:\]|\.)/m, 'uv', '[tool.uv]'],
        [/^\s*\[tool\.pdm(?:\]|\.)/m, 'pdm', '[tool.pdm]'],
      ]
      const matched = pyTools.filter(([re]) => re.test(pyproject))
      if (matched.length === 1) return { manager: matched[0]![1], evidence: `${matched[0]![2]} in ${join(d, 'pyproject.toml')}`, dir: d }
      if (matched.length > 1) return undefined
    }
  }
  return undefined
}

/**
 * Where the upward search for `dir` should stop: the git root above it if there
 * is one, otherwise the session workspace (when `dir` is inside it), otherwise
 * `dir` itself. This keeps a stray lockfile in a home folder or drive root from
 * deciding the manager for a project that has none.
 * @param dir - directory the command runs in.
 * @param workspace - the session's workspace directory.
 * @returns the directory to pass as `stopAt`.
 */
export function searchRoot(dir: string, workspace: string): string {
  const start = resolve(dir)
  for (let d = start, i = 0; i < 40; i += 1) {
    if (existsSync(join(d, '.git'))) return d
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  const ws = resolve(workspace)
  const rel = relative(ws, start)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? ws : start
}

function* ancestors(dir: string, stopAt: string): Generator<string> {
  let d = resolve(dir)
  const stop = resolve(stopAt)
  for (let i = 0; i < 40; i += 1) {
    yield d
    if (d === stop || existsSync(join(d, '.git'))) return
    const parent = dirname(d)
    if (parent === d) return
    d = parent
  }
}

/** A dependency-changing command and its translation. */
export interface Mismatch {
  ecosystem: 'js' | 'py'
  used: string
  expected: string
  /** The offending simple command. */
  command: string
  /** The equivalent command for the project's manager. */
  suggestion: string
}

/** Parsed JS package-manager intent. */
interface JsIntent {
  action: 'install-all' | 'ci' | 'add' | 'remove' | 'update' | 'dlx'
  packages: string[]
  dev: boolean
  global: boolean
  exact: boolean
  optional: boolean
  peer: boolean
  /** Folder the command targets (`--prefix`, `-C`, `--cwd`, `--dir`). */
  dir?: string
  /** npm/yarn workspace or pnpm filter the command targets. */
  workspace?: string
}

/** Flags that take a value, per source manager; the value must not be read as a package. */
const JS_VALUE_FLAGS: Record<JsManager, Record<string, 'dir' | 'workspace' | 'skip'>> = {
  npm: { '--prefix': 'dir', '-C': 'dir', '-w': 'workspace', '--workspace': 'workspace', '--registry': 'skip', '--cache': 'skip', '--tag': 'skip', '--userconfig': 'skip', '--omit': 'skip', '--include': 'skip' },
  pnpm: { '-C': 'dir', '--dir': 'dir', '--filter': 'workspace', '-F': 'workspace', '--registry': 'skip', '--store-dir': 'skip' },
  yarn: { '--cwd': 'dir', '--registry': 'skip', '--mode': 'skip' },
  bun: { '--cwd': 'dir', '--filter': 'workspace', '-F': 'workspace', '--registry': 'skip', '--backend': 'skip' },
}

const JS_ACTIONS: Record<JsManager, Record<string, JsIntent['action']>> = {
  npm: { install: 'add', i: 'add', in: 'add', add: 'add', isntall: 'add', ci: 'ci', 'clean-install': 'ci', uninstall: 'remove', remove: 'remove', rm: 'remove', un: 'remove', r: 'remove', update: 'update', up: 'update', upgrade: 'update' },
  pnpm: { install: 'add', i: 'add', add: 'add', remove: 'remove', rm: 'remove', uninstall: 'remove', un: 'remove', update: 'update', up: 'update', upgrade: 'update' },
  yarn: { install: 'install-all', add: 'add', remove: 'remove', upgrade: 'update', up: 'update' },
  bun: { install: 'add', i: 'add', add: 'add', a: 'add', remove: 'remove', rm: 'remove', update: 'update' },
}

function parseJs(manager: JsManager, argv: string[]): JsIntent | undefined {
  // `pnpm --filter web add x`, `yarn --cwd app add x`: move options that precede the subcommand after it.
  const leading: string[] = []
  let at = 0
  while (at < argv.length && argv[at]!.startsWith('-')) {
    const a = argv[at]!
    leading.push(a)
    at += 1
    if (JS_VALUE_FLAGS[manager][a] !== undefined && at < argv.length) leading.push(argv[at++]!)
  }
  let leadingWorkspace: string | undefined
  if (manager === 'yarn' && argv[at] === 'workspace' && argv[at + 1] !== undefined) {
    leadingWorkspace = argv[at + 1]
    at += 2
  }
  const args = [...argv.slice(at, at + 1), ...leading, ...argv.slice(at + 1)]
  const sub = args[0]
  const yarnInstall = manager === 'yarn' && sub !== undefined && args.every(x => ['--frozen-lockfile', '--immutable', '--pure-lockfile', '--prefer-offline', '--check-files'].includes(x))
  if (sub === undefined || yarnInstall) return manager === 'yarn' ? { action: 'install-all', packages: [], dev: false, global: false, exact: false, optional: false, peer: false } : undefined
  const action = JS_ACTIONS[manager][sub]
  if (action === undefined) return undefined
  const rest = args.slice(1)
  const flag = (...names: string[]): boolean => rest.some(a => names.includes(a))
  const packages: string[] = []
  let dir: string | undefined
  let workspace: string | undefined = leadingWorkspace
  const valueFlags = JS_VALUE_FLAGS[manager]
  for (let k = 0; k < rest.length; k += 1) {
    const a = rest[k]!
    const [name, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const kind = valueFlags[name]
    if (kind !== undefined) {
      const value = inline ?? rest[(k += 1)]
      if (kind === 'dir') dir = value
      if (kind === 'workspace') workspace = value
      continue
    }
    if (!a.startsWith('-')) packages.push(a)
  }
  const global = flag('-g', '--global')
  const intent: JsIntent = {
    action: action === 'add' && packages.length === 0 ? 'install-all' : action,
    packages,
    dev: flag('-D', '--save-dev', '--dev', '-d'),
    global,
    exact: flag('-E', '--save-exact', '--exact'),
    optional: flag('-O', '--save-optional', '--optional'),
    peer: flag('--save-peer', '--peer', '-P'),
    ...(dir === undefined ? {} : { dir }),
    ...(workspace === undefined ? {} : { workspace }),
  }
  return intent
}

function renderJs(target: JsManager, i: JsIntent): string {
  const flags = [i.dev ? '-D' : '', i.exact ? (target === 'yarn' ? '--exact' : '-E') : '', i.optional ? (target === 'npm' ? '-O' : '--optional') : '', i.peer ? (target === 'npm' ? '--save-peer' : '--peer') : ''].filter(Boolean)
  const pkgs = i.packages.join(' ')
  const where = i.dir !== undefined
    ? { npm: `--prefix ${i.dir}`, pnpm: `-C ${i.dir}`, yarn: `--cwd ${i.dir}`, bun: `--cwd ${i.dir}` }[target]
    : i.workspace !== undefined
      ? { npm: `-w ${i.workspace}`, pnpm: `--filter ${i.workspace}`, yarn: `workspace ${i.workspace}`, bun: `--filter ${i.workspace}` }[target]
      : ''
  const join = (...parts: string[]): string => parts.filter(Boolean).join(' ').replace(/^(npm|pnpm|yarn|bun) /, where === '' ? '$1 ' : `$1 ${where} `)
  switch (i.action) {
    case 'install-all': return join(`${target} install`)
    case 'ci': return join({ npm: 'npm ci', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile  # Yarn Berry: yarn install --immutable', bun: 'bun install --frozen-lockfile' }[target])
    case 'add': return join(target === 'npm' ? 'npm install' : `${target} add`, ...flags, pkgs)
    case 'remove': return join(target === 'npm' ? 'npm uninstall' : `${target} remove`, pkgs)
    case 'update': return join(target === 'yarn' ? 'yarn upgrade' : `${target} update`, pkgs)
    default: return join(`${target} install`)
  }
}

/** Parsed pip intent. */
interface PyIntent {
  action: 'add' | 'remove' | 'requirements' | 'editable'
  packages: string[]
  requirements?: string
  upgrade: boolean
}

const PIP_GLOBAL_VALUE_FLAGS = new Set(['--proxy', '--cert', '--client-cert', '--cache-dir', '--timeout', '--retries', '--log', '--exists-action', '--keyring-provider'])

function parsePip(args: string[]): PyIntent | undefined {
  let at = 0
  while (at < args.length && args[at]!.startsWith('-')) {
    const a = args[at]!
    if (a === '--python' || a.startsWith('--python=')) return undefined
    at += 1
    if (PIP_GLOBAL_VALUE_FLAGS.has(a) && at < args.length) at += 1
  }
  const sub = args[at]
  const rest = args.slice(at + 1)
  if (rest.some(a => a === '--python' || a.startsWith('--python='))) return undefined
  if (sub === 'uninstall') {
    if (rest.some(a => a === '-r' || a === '--requirement' || a.startsWith('--requirement=') || (a.startsWith('-r') && a.length > 2))) return undefined
    const packages = rest.filter(a => !a.startsWith('-'))
    if (packages.length === 0) return undefined
    return { action: 'remove', packages, upgrade: false }
  }
  if (sub !== 'install') return undefined
  // Installing into the user site, or upgrading the installers themselves, is not a project dependency.
  if (rest.includes('--user')) return undefined
  for (let k = 0; k < rest.length; k += 1) {
    const a = rest[k]!
    if (a === '-r' || a === '--requirement') return { action: 'requirements', packages: [], requirements: rest[k + 1] ?? 'requirements.txt', upgrade: false }
    if (a.startsWith('--requirement=')) return { action: 'requirements', packages: [], requirements: a.slice('--requirement='.length) || 'requirements.txt', upgrade: false }
    if (a.startsWith('-r') && a.length > 2) return { action: 'requirements', packages: [], requirements: a.slice(2), upgrade: false }
  }
  if (rest.includes('-e') || rest.includes('--editable')) return { action: 'editable', packages: [], upgrade: false }
  const valueFlags = new Set(['-i', '--index-url', '--extra-index-url', '-c', '--constraint', '-t', '--target', '--python-version', '--platform', '-f', '--find-links'])
  const packages: string[] = []
  for (let k = 0; k < rest.length; k += 1) {
    const a = rest[k]!
    if (valueFlags.has(a)) { k += 1; continue }
    if (!a.startsWith('-')) packages.push(a)
  }
  if (packages.length === 0) return undefined
  if (packages.every(p => /^(?:pip|setuptools|wheel|uv|pipx|virtualenv|poetry|pdm|pipenv)(?:[<>=!~].*)?$/i.test(p))) return undefined
  if (packages.some(p => p === '.' || p.startsWith('./') || p.startsWith('/'))) return { action: 'editable', packages: [], upgrade: false }
  return { action: 'add', packages, upgrade: rest.includes('-U') || rest.includes('--upgrade') }
}

function renderPy(target: PyManager, i: PyIntent): string {
  const pkgs = i.packages.map(p => (!/[<>=!~ ;]/.test(p) ? p : p.includes("'") ? `"${p}"` : `'${p}'`)).join(' ')
  switch (i.action) {
    case 'add': return { uv: `uv add ${pkgs}`, poetry: `poetry add ${pkgs}`, pipenv: `pipenv install ${pkgs}`, pdm: `pdm add ${pkgs}`, pip: `pip install ${pkgs}` }[target]
    case 'remove': return { uv: `uv remove ${pkgs}`, poetry: `poetry remove ${pkgs}`, pipenv: `pipenv uninstall ${pkgs}`, pdm: `pdm remove ${pkgs}`, pip: `pip uninstall ${pkgs}` }[target]
    case 'requirements': return { uv: `uv add -r ${i.requirements}  # or, to install without recording: uv pip install -r ${i.requirements}`, poetry: `poetry add $(cat ${i.requirements})  # or run the project's install: poetry install`, pipenv: `pipenv install -r ${i.requirements}`, pdm: `pdm import ${i.requirements}`, pip: `pip install -r ${i.requirements}` }[target]
    case 'editable': return { uv: 'uv sync', poetry: 'poetry install', pipenv: 'pipenv install -e .', pdm: 'pdm install', pip: 'pip install -e .' }[target]
  }
}

const JS_MANAGERS = new Set<string>(['npm', 'pnpm', 'yarn', 'bun'])

/**
 * Check one simple command (argv) against the detected managers.
 * @param argv - program and arguments.
 * @param managers - detected project managers.
 * @param text - raw command text, for reporting.
 * @returns the mismatch, or undefined when the command is fine.
 */
export function checkArgv(argv: string[], managers: ProjectManagers, text: string): Mismatch | undefined {
  // `C:\\Program Files\\nodejs\\npm.cmd` and `pip.exe` are npm and pip.
  const prog = (argv[0] ?? '').split(/[/\\]/).at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
  if (managers.js !== undefined && JS_MANAGERS.has(prog) && prog !== managers.js.manager) {
    const intent = parseJs(prog as JsManager, argv.slice(1))
    if (intent !== undefined && !intent.global) {
      return { ecosystem: 'js', used: prog, expected: managers.js.manager, command: text, suggestion: renderJs(managers.js.manager, intent) }
    }
  }
  if (managers.py !== undefined && managers.py.manager !== 'pip') {
    let pipArgs: string[] | undefined
    if (/^pip3?(\.\d+)?$/.test(prog)) pipArgs = argv.slice(1)
    else if (/^python(\d+(\.\d+)?)?$/.test(prog) && argv[1] === '-m' && argv[2] === 'pip') pipArgs = argv.slice(3)
    else if (prog === 'py') {
      const mIdx = argv[1] !== undefined && /^-\d+(\.\d+)?(-\d+)?$/.test(argv[1]) ? 2 : 1
      if (argv[mIdx] === '-m' && argv[mIdx + 1] === 'pip') pipArgs = argv.slice(mIdx + 2)
    }
    if (pipArgs !== undefined) {
      const intent = parsePip(pipArgs)
      if (intent !== undefined) return { ecosystem: 'py', used: 'pip', expected: managers.py.manager, command: text, suggestion: renderPy(managers.py.manager, intent) }
    }
  }
  return undefined
}

function isBashBacktickSubst(command: string, index: number): boolean {
  const q = command[index + 1]
  if (q !== "'" && q !== '"') return false
  let closeQuote = -1
  for (let j = index + 2; j < command.length; j += 1) {
    const c = command[j]!
    if (c === '\n') return false
    if (q === '"' && c === '\\' && j + 1 < command.length) {
      j += 1
      continue
    }
    if (c === '`' && command[j + 1] === q) {
      j += 1
      continue
    }
    if (c === q) {
      closeQuote = j
      break
    }
  }
  if (closeQuote === -1) return false
  for (let j = closeQuote + 1; j < command.length; j += 1) {
    const c = command[j]!
    if (c === '\n') return false
    if (c === '`') return command[j + 1] !== q
  }
  return false
}

function splitCommands(command: string, shell?: string): string[] {
  const isBash = shell !== undefined && /^(?:bash|sh|zsh|dash|ksh)$/i.test(shell)
  const isPwsh = shell !== undefined && /^(?:pwsh|powershell)$/i.test(shell)
  const parts: string[] = []
  let current = ''
  let atWordStart = true
  let quote: "'" | '"' | "$'" | undefined
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    const next = command[i + 1]
    if (quote !== undefined) {
      const bashEsc = !isPwsh && (
        (quote === '"' && ch === '\\' && (next === '"' || next === '\\'))
        || (quote === "$'" && ch === '\\' && (next === "'" || next === '\\'))
      )
      const pwshEsc = !isBash && quote === '"' && ch === '`' && (
        next === '`' || (next === '"' && (isPwsh || !isBashBacktickSubst(command, i)))
      )
      if (bashEsc || pwshEsc) {
        current += ch + next!
        i += 1
      } else {
        current += ch
        if (ch === (quote === "$'" ? "'" : quote)) quote = undefined
      }
      continue
    }
    if (!isPwsh && ch === '\\' && (next === '\n' || (next === '\r' && command[i + 2] === '\n'))) {
      i += next === '\r' ? 2 : 1
      continue
    }
    if (!isPwsh && ch === '\\' && next !== undefined && (next === "'" || next === '"' || next === '\\' || next === '#' || next === ' ' || next === '\t')) {
      current += ch + next
      i += 1
      atWordStart = false
      continue
    }
    if (!isBash && ch === '`' && next !== undefined && (next === '`' || next === '#' || next === ' ' || next === '\t' || ((next === "'" || next === '"') && (isPwsh || !isBashBacktickSubst(command, i))))) {
      current += ch + next
      i += 1
      atWordStart = false
      continue
    }
    if (ch === '#' && atWordStart) {
      parts.push(current)
      current = ''
      atWordStart = true
      const nl = command.indexOf('\n', i + 1)
      if (nl === -1) break
      i = nl
      continue
    }
    if (!isBash && ch === '<' && next === '#' && atWordStart) {
      const close = command.indexOf('#>', i + 2)
      if (close !== -1) {
        current += ' '
        i = close + 1
        atWordStart = true
        continue
      }
    }
    if (ch === '$' && next === "'") {
      quote = "$'"
      current += "$'"
      i += 1
      atWordStart = false
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      atWordStart = false
      continue
    }
    if (ch === ';' || ch === '\n') {
      parts.push(current)
      current = ''
      atWordStart = true
    } else if (ch === '&' && next === '&') {
      parts.push(current)
      current = ''
      i += 1
      atWordStart = true
    } else if (ch === '|') {
      parts.push(current)
      current = ''
      if (next === '|') i += 1
      atWordStart = true
    } else {
      current += ch
      atWordStart = /\s/.test(ch)
    }
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * Split a command line into argv lists (quotes respected; `cd dir &&` tracked).
 * @param command - raw shell text.
 * @param shell - optional shell tool name (e.g. `bash`, `pwsh`).
 * @returns each simple command with the directory it runs in, relative to the start.
 */
export function simpleCommands(command: string, shell?: string): Array<{ argv: string[]; text: string; cd: string[] }> {
  const out: Array<{ argv: string[]; text: string; cd: string[] }> = []
  let cd: string[] = []
  const stack: string[][] = []
  for (const part of splitCommands(command, shell)) {
    const words = (part.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(w => w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1'))
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
    while (words[0] === 'sudo' || words[0] === 'command' || words[0] === 'exec' || words[0] === '&') words.shift()
    if (words.length === 0) continue
    if (/^(?:popd|pop-location)$/i.test(words[0]!)) {
      const prev = stack.pop()
      if (prev !== undefined) cd = prev
      continue
    }
    // PowerShell's Set-Location / sl / Push-Location / pushd move the same way `cd` does.
    if (/^(?:cd|set-location|sl|chdir|pushd|push-location)$/i.test(words[0]!)) {
      if (/^(?:pushd|push-location)$/i.test(words[0]!)) stack.push([...cd])
      const target = words[1] === '--' || /^-(?:path|literalpath)$/i.test(words[1] ?? '') ? words[2] : words[1]
      if (target !== undefined && target !== '-') cd.push(target)
      continue
    }
    out.push({ argv: words, text: part.trim(), cd: [...cd] })
  }
  return out
}

/**
 * Shorten paths inside `evidence` relative to `workspace` on both POSIX and Windows.
 * @param evidence - raw detection evidence string.
 * @param workspace - the session's workspace directory.
 * @returns evidence with the workspace prefix stripped or replaced by `.`.
 */
export function formatEvidence(evidence: string, workspace: string): string {
  const trimmed = workspace.replace(/[/\\]+$/, '')
  if (trimmed === '') return evidence
  const withPrefix = evidence.replace(`${trimmed}/`, '').replace(`${trimmed}\\`, '')
  if (withPrefix !== evidence) return withPrefix
  return evidence.endsWith(trimmed) ? `${evidence.slice(0, -trimmed.length)}.` : evidence
}
