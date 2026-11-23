import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkArgv, detectJs, detectPy, formatEvidence, searchRoot, simpleCommands, type ProjectManagers } from '../src/detect.ts'

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

// Each temp project is its own root, so nothing above it (a stray lockfile in
// the home folder, say) can leak into the result.
const detectJsHere = (files: Record<string, string>) => { const d = project(files); return detectJs(d, d) }
const detectPyHere = (files: Record<string, string>) => { const d = project(files); return detectPy(d, d) }

test('JS detection: packageManager field beats lockfiles', () => {
  const d = project({ 'package.json': '{"packageManager":"pnpm@9.12.0"}', 'package-lock.json': '{}' })
  assert.equal(detectJs(d, d)?.manager, 'pnpm')
})

test('JS detection: lockfiles, workspace file, nested packages, ambiguity', () => {
  assert.equal(detectJsHere({ 'yarn.lock': '' })?.manager, 'yarn')
  assert.equal(detectJsHere({ 'bun.lock': '' })?.manager, 'bun')
  const mono = project({ 'pnpm-workspace.yaml': 'packages: [apps/*]', 'apps/web/package.json': '{}' })
  assert.equal(detectJs(join(mono, 'apps/web'), mono)?.manager, 'pnpm')
  assert.equal(detectJsHere({ 'yarn.lock': '', 'package-lock.json': '{}' }), undefined)
  assert.equal(detectJsHere({ 'package.json': '{}' }), undefined)
})

test('the search stops at the workspace or git root, not at a parent lockfile', () => {
  const home = project({ 'package-lock.json': '{}', 'app/package.json': '{}', 'repo/.git/HEAD': '', 'repo/pkg/package.json': '{}' })
  const app = join(home, 'app')
  assert.equal(searchRoot(app, app), app)
  assert.equal(detectJs(app, searchRoot(app, app)), undefined)
  const pkg = join(home, 'repo', 'pkg')
  assert.equal(searchRoot(pkg, pkg), join(home, 'repo'))
  assert.equal(detectJs(pkg, searchRoot(pkg, pkg)), undefined)
  // A monorepo package opened on its own still finds the workspace above it.
  const mono = project({ '.git/HEAD': '', 'pnpm-workspace.yaml': 'packages: [apps/*]', 'apps/web/package.json': '{}' })
  const web = join(mono, 'apps', 'web')
  assert.equal(detectJs(web, searchRoot(web, web))?.manager, 'pnpm')
  // A `cd` outside the workspace stops at the target directory.
  assert.equal(searchRoot(app, join(home, 'elsewhere')), app)
})

test('Python detection', () => {
  assert.equal(detectPyHere({ 'uv.lock': '' })?.manager, 'uv')
  assert.equal(detectPyHere({ 'poetry.lock': '' })?.manager, 'poetry')
  assert.equal(detectPyHere({ 'pyproject.toml': '[tool.poetry]\nname="x"' })?.manager, 'poetry')
  assert.equal(detectPyHere({ 'pyproject.toml': '[tool.poetry.dependencies]\npython="^3.12"' })?.manager, 'poetry')
  assert.equal(detectPyHere({ 'pyproject.toml': '[tool.uv.sources]\nfoo = { workspace = true }' })?.manager, 'uv')
  assert.equal(detectPyHere({ 'pyproject.toml': '[tool.pdm.dev-dependencies]\ndev = []' })?.manager, 'pdm')
  assert.equal(detectPyHere({ 'Pipfile': '' })?.manager, 'pipenv')
  assert.equal(detectPyHere({ 'pyproject.toml': '[project]\nname="x"' }), undefined)
  assert.equal(detectPyHere({ 'uv.lock': '', 'poetry.lock': '' }), undefined)
  const uvWs = project({ 'uv.lock': '', 'pyproject.toml': '[tool.uv.workspace]\nmembers=["packages/*"]', 'packages/app/pyproject.toml': '[project]\nname="app"' })
  assert.equal(detectPy(join(uvWs, 'packages/app'), uvWs)?.manager, 'uv')
})

const js = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): ProjectManagers => ({ js: { manager, evidence: 'x', dir: '/' } })
const py = (manager: 'uv' | 'poetry' | 'pipenv' | 'pdm'): ProjectManagers => ({ py: { manager, evidence: 'x', dir: '/' } })
const suggest = (cmd: string, m: ProjectManagers): string | undefined => {
  const [s] = simpleCommands(cmd)
  return checkArgv(s!.argv, m, s!.text)?.suggestion
}

test('JS translations', () => {
  assert.equal(suggest('npm install zod', js('pnpm')), 'pnpm add zod')
  assert.equal(suggest('npm i -D vitest @types/node', js('pnpm')), 'pnpm add -D vitest @types/node')
  assert.equal(suggest('npm install', js('yarn')), 'yarn install')
  assert.equal(suggest('npm ci', js('pnpm')), 'pnpm install --frozen-lockfile')
  assert.equal(suggest('yarn add react -D', js('npm')), 'npm install -D react')
  assert.equal(suggest('pnpm remove lodash', js('bun')), 'bun remove lodash')
  assert.equal(suggest('yarn', js('pnpm')), 'pnpm install')
  assert.equal(suggest('npm uninstall left-pad', js('yarn')), 'yarn remove left-pad')
  assert.equal(suggest('npm install global', js('pnpm')), 'pnpm add global')
})

test('JS: the right manager, global installs, and scripts are allowed', () => {
  assert.equal(suggest('pnpm add zod', js('pnpm')), undefined)
  assert.equal(suggest('npm i -g typescript', js('pnpm')), undefined)
  assert.equal(suggest('yarn global add typescript', js('pnpm')), undefined)
  assert.equal(suggest('npm run build', js('pnpm')), undefined)
  assert.equal(suggest('npm test', js('yarn')), undefined)
  assert.equal(suggest('npx tsc', js('pnpm')), undefined)
})

test('Python translations', () => {
  assert.equal(suggest('pip install requests', py('uv')), 'uv add requests')
  assert.equal(suggest('pip --disable-pip-version-check install requests', py('uv')), 'uv add requests')
  assert.equal(suggest('pip --python C:/external install requests', py('uv')), undefined)
  assert.equal(suggest('pip --python=C:/external install requests', py('uv')), undefined)
  assert.equal(suggest('pip install --python C:/external requests', py('uv')), undefined)
  assert.equal(suggest('python -m pip install "fastapi>=0.110"', py('poetry')), "poetry add 'fastapi>=0.110'")
  assert.equal(suggest('pip install "pkg>=1.0; python_version<\'3.12\'"', py('uv')), 'uv add "pkg>=1.0; python_version<\'3.12\'"')
  assert.equal(suggest('pip3 uninstall flask', py('pdm')), 'pdm remove flask')
  assert.equal(suggest('pip uninstall -y', py('uv')), undefined)
  assert.equal(suggest('pip uninstall -r requirements.txt', py('uv')), undefined)
  assert.equal(suggest('pip install -e .', py('uv')), 'uv sync')
  assert.match(suggest('pip install -r requirements.txt', py('uv'))!, /^uv add -r requirements\.txt/)
  assert.match(suggest('pip install --requirement=dev-reqs.txt', py('uv'))!, /^uv add -r dev-reqs\.txt/)
  assert.equal(suggest('uv pip install requests', py('uv')), undefined)
  assert.equal(suggest('pip list', py('uv')), undefined)
  assert.equal(suggest('pip install requests', {}), undefined)
})

test('simpleCommands tracks cd, popd, and respects quotes', () => {
  const cmds = simpleCommands('cd apps/web && npm install zod; echo done')
  assert.deepEqual(cmds.map(c => [c.argv[0], c.cd]), [['npm', ['apps/web']], ['echo', ['apps/web']]])
  const pushed = simpleCommands('pushd apps/web && npm i zod && popd && npm i lodash')
  assert.deepEqual(pushed.map(c => [c.argv[0], c.cd]), [['npm', ['apps/web']], ['npm', []]])
  const quoted = simpleCommands('echo "a; b && c" && npm i zod')
  assert.deepEqual(quoted.map(c => c.argv), [['echo', 'a; b && c'], ['npm', 'i', 'zod']])
  const flaggedCd = simpleCommands('cd -- apps/web && Set-Location -Path sub && npm i react')
  assert.deepEqual(flaggedCd.map(c => c.cd), [['apps/web', 'sub']])
})

test('options before or around the subcommand are translated, not mistaken for packages', () => {
  const pm = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): ProjectManagers => ({ js: { manager, evidence: 'e', dir: '/' } })
  const s = (cmd: string, to: 'npm' | 'pnpm' | 'yarn' | 'bun'): string | undefined => checkArgv(cmd.split(' '), pm(to), cmd)?.suggestion
  assert.equal(s('npm install --prefix packages/web', 'pnpm'), 'pnpm -C packages/web install')
  assert.equal(s('npm i -w web react', 'pnpm'), 'pnpm --filter web add react')
  assert.equal(s('npm i -w web react', 'yarn'), 'yarn workspace web add react')
  assert.equal(s('yarn workspace web add react', 'pnpm'), 'pnpm --filter web add react')
  assert.equal(s('bun --filter web add react', 'pnpm'), 'pnpm --filter web add react')
  assert.equal(s('pnpm --filter web add react', 'npm'), 'npm -w web install react')
  assert.equal(s('yarn --cwd app add x', 'npm'), 'npm --prefix app install x')
  assert.equal(s('yarn --frozen-lockfile', 'pnpm'), 'pnpm install')
  assert.equal(s('npm --version', 'pnpm'), undefined)
})

test('pip installs of tooling or into the user site are left alone', () => {
  const pm: ProjectManagers = { py: { manager: 'uv', evidence: 'e', dir: '/' } }
  for (const cmd of ['pip install --upgrade pip', 'pip3 install -U uv', 'pip install --user pipx']) assert.equal(checkArgv(cmd.split(' '), pm, cmd), undefined, cmd)
  assert.equal(checkArgv('pip install httpx'.split(' '), pm, 'pip install httpx')?.suggestion, 'uv add httpx')
})

test('PowerShell spellings: npm.cmd, full paths, py launcher, & and Set-Location', () => {
  const pm: ProjectManagers = { js: { manager: 'pnpm', evidence: 'e', dir: '/' }, py: { manager: 'uv', evidence: 'e', dir: '/' } }
  const s = (cmd: string): Array<string | undefined> => simpleCommands(cmd).map(c => checkArgv(c.argv, pm, c.text)?.suggestion)
  assert.deepEqual(s('npm.cmd install zod'), ['pnpm add zod'])
  assert.deepEqual(s('& "C:\\Program Files\\nodejs\\npm.cmd" i -D vitest'), ['pnpm add -D vitest'])
  assert.deepEqual(s('C:\\Python312\\Scripts\\pip.exe install httpx'), ['uv add httpx'])
  assert.deepEqual(s('py -m pip install httpx'), ['uv add httpx'])
  assert.deepEqual(s('py -3.12 -m pip install httpx'), ['uv add httpx'])
  const moved = simpleCommands('Set-Location web; npm i react')
  assert.deepEqual(moved.map(c => c.cd), [['web']])
})

test('formatEvidence strips POSIX and Windows workspace prefixes without mangling siblings', () => {
  assert.equal(formatEvidence('"packageManager": "pnpm@…" in /work/app/package.json', '/work/app'), '"packageManager": "pnpm@…" in package.json')
  assert.equal(formatEvidence('pnpm-lock.yaml in /work/app', '/work/app'), 'pnpm-lock.yaml in .')
  assert.equal(formatEvidence('"packageManager": "pnpm@…" in C:\\work\\app\\package.json', 'C:\\work\\app'), '"packageManager": "pnpm@…" in package.json')
  assert.equal(formatEvidence('pnpm-lock.yaml in C:\\work\\app', 'C:\\work\\app'), 'pnpm-lock.yaml in .')
  assert.equal(formatEvidence('pnpm-lock.yaml in /work/app2', '/work/app'), 'pnpm-lock.yaml in /work/app2')
})

test('simpleCommands respects shell escapes and comments when splitting commands', () => {
  const pnpm = js('pnpm')
  const suggestions = (cmd: string): string[] =>
    simpleCommands(cmd).map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined)

  assert.deepEqual(suggestions("echo don\\'t && npm install zod"), ['pnpm add zod'])
  assert.deepEqual(suggestions("echo ready # don't edit\nnpm install zod"), ['pnpm add zod'])
  assert.deepEqual(suggestions('Write-Output `"ready; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions('echo \\"ready && npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions("echo $'don\\'t' && npm install zod"), ['pnpm add zod'])
  assert.deepEqual(suggestions('Write-Output "a `"b`""; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions("Write-Output ok <# don't edit #>; npm install zod"), ['pnpm add zod'])
  assert.deepEqual(suggestions('echo a#b && npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions('echo "a # b" && npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions('echo build\\ #1; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions('echo `"printf" ready`; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(suggestions('Write-Output <# note #> npm install zod'), [])
  assert.deepEqual(
    simpleCommands('echo build\\ #1; npm install zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('echo `"printf" ready`; npm install zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('Write-Output <# note #> npm install zod', 'pwsh').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    [],
  )
  assert.deepEqual(suggestions('Write-Output build` #1; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(
    simpleCommands('Write-Output build` #1; npm install zod', 'pwsh').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('Write-Output `#1; npm install zod', 'pwsh').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('Write-Output build`` #1; npm install zod', 'pwsh').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    [],
  )
  assert.deepEqual(suggestions('echo build\\\n#1; npm install zod'), ['pnpm add zod'])
  assert.deepEqual(
    simpleCommands('echo build\\\n#1; npm install zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('echo build\\\r\n#1; npm install zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('npm \\\ninstall zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    ['pnpm add zod'],
  )
  assert.deepEqual(
    simpleCommands('echo \\\\\n#1; npm install zod', 'bash').map(c => checkArgv(c.argv, pnpm, c.text)?.suggestion).filter((s): s is string => s !== undefined),
    [],
  )
})

test('simpleCommands popd restores the directory saved by pushd across intermediate cd calls', () => {
  const root = project({
    'pnpm-lock.yaml': '',
    'apps/package-lock.json': '{}',
    'other/pnpm-lock.yaml': '',
  })
  const cmds = simpleCommands('pushd apps; cd ../other; popd; npm install zod')
  assert.equal(cmds.length, 1)
  assert.deepEqual(cmds[0]!.cd, [])
  const dir = cmds[0]!.cd.reduce((d, c) => resolve(d, c.replaceAll('\\', '/')), root)
  const detected = detectJs(dir, root)
  assert.ok(detected !== undefined)
  assert.equal(detected.manager, 'pnpm')
  assert.equal(checkArgv(cmds[0]!.argv, { js: detected }, cmds[0]!.text)?.suggestion, 'pnpm add zod')

  const nested = simpleCommands('cd a; pushd b; cd c; pushd d; cd e; popd; npm i x; popd; npm i y')
  assert.deepEqual(nested.map(c => c.cd), [['a', 'b', 'c'], ['a']])

  const psStack = simpleCommands('Push-Location apps; Set-Location ../other; Pop-Location; npm install zod')
  assert.deepEqual(psStack.map(c => c.cd), [[]])

  const emptyPop = simpleCommands('cd apps; popd; npm install zod')
  assert.deepEqual(emptyPop.map(c => c.cd), [['apps']])
})
