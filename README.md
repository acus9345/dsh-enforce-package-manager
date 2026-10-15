# dsh-enforce-package-manager

Your repo uses pnpm, and the agent types `npm install zod`. Now you've got a `package-lock.json` sitting next to `pnpm-lock.yaml`, and a dependency that pnpm doesn't know about. On the Python side it's `pip install requests` in a uv project. The package lands in the venv, never reaches `pyproject.toml`, and vanishes on the next `uv sync`.

This [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin works out which package manager the project uses. If the agent reaches for a different one, the command is stopped and the model gets the right command, already translated:

```
dsh-enforce-package-manager blocked `npm install zod --save-dev`: this project uses pnpm,
not npm ("packageManager": "pnpm@…" in /work/app/package.json). Mixing package managers
creates a second lockfile, ignores the existing one, and can install different versions.
Run this instead:
  pnpm add -D zod
```

The model usually just runs the suggested line next.

## Install

```sh
dsh plugin --profile tui add dsh-enforce-package-manager
```

Use your own profile instead of `tui`. Nothing else to set up. Remove it with `dsh plugin --profile tui remove dsh-enforce-package-manager`.

## How it detects the project's manager

It starts in the directory the command will run in, following any `cd` earlier in the same command line. From there it walks up toward the repo root and stops at the first directory that answers the question.

For JavaScript, a `packageManager` field in `package.json` wins. After that it looks for a single lockfile: `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` / `bun.lockb` or `package-lock.json`. If it finds lockfiles from two different managers, it doesn't guess and stays out of the way.

For Python it looks for `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile`, or a `[tool.poetry]` / `[tool.uv]` / `[tool.pdm]` section in `pyproject.toml`. A project with only `requirements.txt` has no manager to enforce, so pip is left alone there.

## What gets translated

| The agent runs | In a pnpm project | In a uv project |
| --- | --- | --- |
| `npm install` | `pnpm install` | |
| `npm ci` | `pnpm install --frozen-lockfile` | |
| `npm i -D vitest` | `pnpm add -D vitest` | |
| `yarn add zod` | `pnpm add zod` | |
| `npm uninstall left-pad` | `pnpm remove left-pad` | |
| `pip install httpx` | | `uv add httpx` |
| `python -m pip install -e .` | | `uv sync` |
| `pip uninstall httpx` | | `uv remove httpx` |

The same goes for yarn, bun and npm projects, and for poetry (`poetry add`), pipenv (`pipenv install`) and pdm (`pdm add`).

Folder and workspace options carry over too. `npm i -w web react` becomes `pnpm --filter web add react` (or `yarn workspace web add react`), and `npm install --prefix api` becomes `pnpm -C api install`.

It only cares about commands that change the project's dependencies. `npm run build`, `npm test`, `npx vitest` and global installs (`npm i -g ...`) pass, because they don't touch the project's lockfile. On the Python side, `pip install --user ...` and upgrading the installers themselves (`pip install -U pip`, `pip install uv`) are left alone for the same reason.

## Settings

Add a row like this to `~/.dsh/profiles/<profile>/cordis.patch.yml`, or to `~/.dsh/cordis.patch.yml` for every profile. Keys you leave out keep their defaults.

```yaml
- id: enforce-package-manager
  config:
    mode: deny          # or `ask` to approve mismatches yourself
    javascript: true    # false: don't police npm/pnpm/yarn/bun
    python: true        # false: don't police pip
    shellTools: [bash]
```

## Development

```sh
npm install
npm test           # detection and translation unit tests
npm run test:e2e   # real dsh runs against a scripted local model, no API key needed
```

MIT licensed.
