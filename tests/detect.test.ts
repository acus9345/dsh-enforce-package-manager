import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkArgv, detectJs, detectPy, simpleCommands, type ProjectManagers } from '../src/detect.ts'

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

test('JS detection: packageManager field beats lockfiles', () => {
  const d = project({ 'package.json': '{"packageManager":"pnpm@9.12.0"}', 'package-lock.json': '{}' })
  assert.equal(detectJs(d, d)?.manager, 'pnpm')
})

test('JS detection: lockfiles, workspace file, nested packages, ambiguity', () => {
  assert.equal(detectJs(project({ 'yarn.lock': '' }), '/')?.manager, 'yarn')
  assert.equal(detectJs(project({ 'bun.lock': '' }), '/')?.manager, 'bun')
  const mono = project({ 'pnpm-workspace.yaml': 'packages: [apps/*]', 'apps/web/package.json': '{}' })
  assert.equal(detectJs(join(mono, 'apps/web'), mono)?.manager, 'pnpm')
  assert.equal(detectJs(project({ 'yarn.lock': '', 'package-lock.json': '{}' }), '/'), undefined)
  assert.equal(detectJs(project({ 'package.json': '{}' }), '/'), undefined)
})

test('Python detection', () => {
  assert.equal(detectPy(project({ 'uv.lock': '' }), '/')?.manager, 'uv')
  assert.equal(detectPy(project({ 'poetry.lock': '' }), '/')?.manager, 'poetry')
  assert.equal(detectPy(project({ 'pyproject.toml': '[tool.poetry]\nname="x"' }), '/')?.manager, 'poetry')
  assert.equal(detectPy(project({ 'Pipfile': '' }), '/')?.manager, 'pipenv')
  assert.equal(detectPy(project({ 'pyproject.toml': '[project]\nname="x"' }), '/'), undefined)
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
})

test('JS: the right manager, global installs, and scripts are allowed', () => {
  assert.equal(suggest('pnpm add zod', js('pnpm')), undefined)
  assert.equal(suggest('npm i -g typescript', js('pnpm')), undefined)
  assert.equal(suggest('npm run build', js('pnpm')), undefined)
  assert.equal(suggest('npm test', js('yarn')), undefined)
  assert.equal(suggest('npx tsc', js('pnpm')), undefined)
})

test('Python translations', () => {
  assert.equal(suggest('pip install requests', py('uv')), 'uv add requests')
  assert.equal(suggest('python -m pip install "fastapi>=0.110"', py('poetry')), "poetry add 'fastapi>=0.110'")
  assert.equal(suggest('pip3 uninstall flask', py('pdm')), 'pdm remove flask')
  assert.equal(suggest('pip install -e .', py('uv')), 'uv sync')
  assert.match(suggest('pip install -r requirements.txt', py('uv'))!, /^uv add -r requirements\.txt/)
  assert.equal(suggest('uv pip install requests', py('uv')), undefined)
  assert.equal(suggest('pip list', py('uv')), undefined)
  assert.equal(suggest('pip install requests', {}), undefined)
})

test('simpleCommands tracks cd', () => {
  const cmds = simpleCommands('cd apps/web && npm install zod; echo done')
  assert.deepEqual(cmds.map(c => [c.argv[0], c.cd]), [['npm', ['apps/web']], ['echo', ['apps/web']]])
})

test('options before or around the subcommand are translated, not mistaken for packages', () => {
  const pm = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): ProjectManagers => ({ js: { manager, evidence: 'e', dir: '/' } })
  const s = (cmd: string, to: 'npm' | 'pnpm' | 'yarn' | 'bun'): string | undefined => checkArgv(cmd.split(' '), pm(to), cmd)?.suggestion
  assert.equal(s('npm install --prefix packages/web', 'pnpm'), 'pnpm -C packages/web install')
  assert.equal(s('npm i -w web react', 'pnpm'), 'pnpm --filter web add react')
  assert.equal(s('npm i -w web react', 'yarn'), 'yarn workspace web add react')
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

test('PowerShell spellings: npm.cmd, full paths, & and Set-Location', () => {
  const pm: ProjectManagers = { js: { manager: 'pnpm', evidence: 'e', dir: '/' }, py: { manager: 'uv', evidence: 'e', dir: '/' } }
  const s = (cmd: string): Array<string | undefined> => simpleCommands(cmd).map(c => checkArgv(c.argv, pm, c.text)?.suggestion)
  assert.deepEqual(s('npm.cmd install zod'), ['pnpm add zod'])
  assert.deepEqual(s('& "C:\\Program Files\\nodejs\\npm.cmd" i -D vitest'), ['pnpm add -D vitest'])
  assert.deepEqual(s('C:\\Python312\\Scripts\\pip.exe install httpx'), ['uv add httpx'])
  const moved = simpleCommands('Set-Location web; npm i react')
  assert.deepEqual(moved.map(c => c.cd), [['web']])
})
