# dsh-enforce-package-manager

[English](README.md) | 中文

你的仓库用的是 pnpm，智能体却敲了 `npm install zod`。现在 `pnpm-lock.yaml` 旁边多了一个 `package-lock.json`，还多了一个 pnpm 不知道的依赖。Python 这边也一样：在 uv 项目里 `pip install requests`，包装进了虚拟环境，却没写进 `pyproject.toml`，下次 `uv sync` 就没了。

这个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件会判断项目用的是哪个包管理器。如果智能体用了别的，命令会被拦下，模型会拿到已经翻译好的正确命令（提示是英文的，模型能看懂）：

```
dsh-enforce-package-manager blocked `npm install zod --save-dev`: this project uses pnpm,
not npm ("packageManager": "pnpm@…" in /work/app/package.json). Mixing package managers
creates a second lockfile, ignores the existing one, and can install different versions.
Run this instead:
  pnpm add -D zod
```

模型通常下一步就会直接运行建议的命令。

## 安装

```sh
dsh plugin --profile web add dsh-enforce-package-manager
```

这里用的是 `web` 配置（profile），也就是用 `dsh web` 打开的浏览器界面。如果你用别的方式运行 DSH，就换成 `headless`（脚本和 CI）或 `acp`（编辑器集成）。每个配置有自己的插件列表，你用到哪个就装到哪个。不需要别的设置。卸载用 `dsh plugin --profile web remove dsh-enforce-package-manager`。

### 从源码安装

想试本地改动的话，打个包再装：

```sh
git clone https://github.com/acus9345/dsh-enforce-package-manager
cd dsh-enforce-package-manager
npm install
npm pack
dsh plugin --profile web add ./dsh-enforce-package-manager-0.2.0.tgz
```

## 怎么判断项目用的包管理器

从命令要运行的目录开始（同一行命令里前面的 `cd` 也会跟着算），往上一层层找，找到第一个能回答问题的目录就停。它不会越过 git 根目录；没有 git 仓库时，也不会越过你启动 DSH 的目录。所以你主目录里一个多余的锁文件不会影响判断。

JavaScript 项目以 `package.json` 里的 `packageManager` 字段为准。没有这个字段时，就找唯一的锁文件：`pnpm-lock.yaml`、`yarn.lock`、`bun.lock` / `bun.lockb` 或 `package-lock.json`。如果同时找到两个不同包管理器的锁文件，它不会乱猜，直接不管。

Python 项目看 `uv.lock`、`poetry.lock`、`pdm.lock`、`Pipfile`，或者 `pyproject.toml` 里的 `[tool.poetry]` / `[tool.uv]` / `[tool.pdm]` 段。只有 `requirements.txt` 的项目没有可约束的包管理器，那里的 pip 不受影响。

## 会翻译成什么

| 智能体运行 | 在 pnpm 项目里 | 在 uv 项目里 |
| --- | --- | --- |
| `npm install` | `pnpm install` | |
| `npm ci` | `pnpm install --frozen-lockfile` | |
| `npm i -D vitest` | `pnpm add -D vitest` | |
| `yarn add zod` | `pnpm add zod` | |
| `npm uninstall left-pad` | `pnpm remove left-pad` | |
| `pip install httpx` | | `uv add httpx` |
| `python -m pip install -e .` | | `uv sync` |
| `pip uninstall httpx` | | `uv remove httpx` |

yarn、bun、npm 项目同理，poetry（`poetry add`）、pipenv（`pipenv install`）、pdm（`pdm add`）也一样。

目录和 workspace 参数也会一起转换。`npm i -w web react` 会变成 `pnpm --filter web add react`（或 `yarn workspace web add react`），`npm install --prefix api` 会变成 `pnpm -C api install`。

在 Windows 上，DSH 用 PowerShell 运行命令，同样的检查也适用于 `npm.cmd`、`pip.exe`、完整的程序路径和 `Set-Location`。

它只管会改动项目依赖的命令。`npm run build`、`npm test`、`npx vitest` 和全局安装（`npm i -g ...`）都会放行，因为它们不碰项目的锁文件。Python 这边，`pip install --user ...` 和升级安装工具本身（`pip install -U pip`、`pip install uv`）也出于同样的原因不管。

## 设置

最简单的办法：在 DSH 侧边栏打开 **插件**，点 **dsh-enforce-package-manager**，改好后点 **保存**。下一次工具调用就生效，不用重启。

或者在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行这样的配置（只影响一个配置），或者加到 `~/.dsh/cordis.patch.yml`（影响所有配置）。没写的项保持默认值。

```yaml
- id: enforce-package-manager
  config:
    mode: deny          # 或 `ask`，自己审批不一致的情况
    javascript: true    # false：不管 npm/pnpm/yarn/bun
    python: true        # false：不管 pip
    shellTools: [bash, pwsh]   # Windows 上 DSH 用的 shell 是 pwsh
```

## 开发

```sh
npm install
npm test           # 检测和翻译的单元测试
npm run test:e2e   # 用脚本模拟的本地模型跑真实的 dsh，不需要 API Key
```

安装测试会执行 `dsh plugin add`，需要 PATH 里有 `pnpm`。

MIT 许可。作者 [acus9345](https://github.com/acus9345)。欢迎在 issues 里报 bug 或提想法。
