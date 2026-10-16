// Settings page for DSH's sidebar Plugins page (the browser half of this plugin).
// Plain JavaScript in DSH's client module format, so it ships without a bundler.
// The top part describes this plugin's fields; the bottom part is the same in
// all six dsh-* plugins.
window.__ModuleLoader__.load({
  id: 'dsh-enforce-package-manager',
  factory: (require) => {
    const module = { exports: {} }
    const { jsx, jsxs } = require('react/jsx-runtime')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    // ---- This plugin ------------------------------------------------------

    const PACKAGE = 'dsh-enforce-package-manager'
    const ENTRY = 'enforce-package-manager'

    const FIELDS = [
      { kind: 'choice', field: 'mode', options: ['deny', 'ask'], fallback: 'deny' },
      { kind: 'switch', field: 'javascript', fallback: true },
      { kind: 'switch', field: 'python', fallback: true },
      { kind: 'words', field: 'shellTools' },
    ]

    const COPY = {
      en: {
        summary: 'Catches the wrong package manager (npm in a pnpm repo, pip in a uv project) and gives the right command.',
        mode_label: 'When the wrong package manager is used',
        mode_hint: 'Block gives the model the exact command for this project. Ask shows you an approval prompt.',
        mode_deny: 'Block it',
        mode_ask: 'Ask me',
        javascript_label: 'Check JavaScript projects',
        javascript_hint: 'npm, pnpm, yarn and bun, detected from packageManager, lockfiles and pnpm-workspace.yaml.',
        python_label: 'Check Python projects',
        python_hint: 'Plain pip in a project managed by uv, poetry, pdm or pipenv.',
        shellTools_label: 'Shell tools to watch',
        shellTools_hint: 'Tool names, separated by commas. On Windows the shell tool is pwsh.',
      },
      zh: {
        summary: '发现用错包管理器（pnpm 项目里用 npm、uv 项目里用 pip）时，给出正确的命令。',
        mode_label: '用错包管理器时',
        mode_hint: '阻止：把这个项目该用的确切命令告诉模型。询问：弹出审批让你决定。',
        mode_deny: '阻止',
        mode_ask: '询问我',
        javascript_label: '检查 JavaScript 项目',
        javascript_hint: 'npm、pnpm、yarn 和 bun，根据 packageManager 字段、锁文件和 pnpm-workspace.yaml 判断。',
        python_label: '检查 Python 项目',
        python_hint: '在用 uv、poetry、pdm 或 pipenv 管理的项目里直接用 pip。',
        shellTools_label: '要检查的 shell 工具',
        shellTools_hint: '工具名，用逗号分隔。Windows 上 shell 工具是 pwsh。',
      },
    }

    // ---- Shared page (identical in every dsh-* plugin) ---------------------

    const FORM_COPY = {
      en: { unavailable: 'This plugin is not loaded, so it cannot be configured right now.', readOnly: 'This deployment stores settings read-only.', saveFailed: 'DSH did not accept these values; they were left for you to correct.', save: 'Save', saving: 'Saving…', overridden: 'Changed', reset: 'Reset to default', invalid: 'Enter a number, or leave blank for the default.' },
      zh: { unavailable: '该插件当前未加载，暂时无法配置。', readOnly: '本部署的设置为只读。', saveFailed: 'DSH 没有接受这些值，已保留供你修改。', save: '保存', saving: '保存中…', overridden: '已修改', reset: '恢复默认', invalid: '请填数字；留空表示使用默认值。' },
    }
    const NS = `plugin.${PACKAGE}`

    /** Text <-> config value conversions for each kind of control. */
    const SPECS = {
      choice: (f) => ({ field: f.field, format: (v) => (typeof v === 'string' ? v : f.fallback), parse: (t) => (f.options.includes(t) ? { kind: 'set', value: t } : undefined) }),
      switch: (f) => ({ field: f.field, format: (v) => String(typeof v === 'boolean' ? v : f.fallback), parse: (t) => (t === 'true' || t === 'false' ? { kind: 'set', value: t === 'true' } : undefined) }),
      number: (f) => P.settingsNumberField(f.field),
      lines: (f) => ({ field: f.field, format: (v) => (Array.isArray(v) ? v.join('\n') : ''), parse: (t) => ({ kind: 'set', value: t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }) }),
      words: (f) => ({ field: f.field, format: (v) => (Array.isArray(v) ? v.join(', ') : ''), parse: (t) => ({ kind: 'set', value: t.split(/[\s,]+/).filter(Boolean) }) }),
      flags: (f) => ({ field: f.field, format: (v) => (Array.isArray(v) ? [...v].sort().join(',') : ''), parse: (t) => ({ kind: 'set', value: t ? t.split(',') : [] }) }),
      pairs: (f) => ({
        field: f.field,
        format: (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).map(([k, val]) => `${k} = ${val}`).join('\n') : ''),
        parse: (t) => ({ kind: 'set', value: Object.fromEntries(t.split(/\r?\n/).map((line) => { const i = line.indexOf('='); return i < 0 ? [line.trim(), ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()] }).filter(([k]) => k)) }),
      }),
    }

    // Same look as DSH's own settings fields (primitives' fields.module.css).
    const S = {
      field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
      divider: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      reset: { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      badges: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      textarea: { minHeight: 96, padding: '8px 12px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', resize: 'vertical' },
      flags: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 },
    }

    function Head({ id, label, state, form, t }) {
      return jsxs('div', {
        style: S.head,
        children: [
          jsx('label', { style: S.label, htmlFor: id, children: label }),
          state.overridden ? jsxs('span', { style: S.badges, children: [jsx(P.Tag, { tone: 'neutral', children: t('overridden') }), jsx('button', { type: 'button', style: S.reset, disabled: form.disabled, onClick: () => form.resetField(form.fieldName), children: t('reset') })] }) : null,
        ],
      })
    }

    function Field({ f, state, props, disabled, first, t, ft }) {
      const id = `${PACKAGE}-${f.field}`
      const label = t(`${f.field}_label`)
      const hintKey = `${f.field}_hint`
      const hintText = t(hintKey)
      const hint = typeof hintText === 'string' && hintText !== hintKey ? hintText : ''
      const edit = (text) => props.edit(f.field, text)
      const wrap = (control) => jsxs('div', {
        style: first ? S.field : { ...S.field, ...S.divider },
        children: [jsx(Head, { id, label, state, t: ft, form: { disabled, resetField: props.resetField, fieldName: f.field } }), control, hint ? jsx('p', { style: S.hint, children: hint }) : null],
      })
      switch (f.kind) {
        case 'number':
        case 'words':
          return jsx('div', {
            style: first ? undefined : S.divider,
            children: jsx(P.SettingsValueField, { id, label, hint, overriddenLabel: ft('overridden'), resetLabel: ft('reset'), invalidLabel: ft('invalid'), numeric: f.kind === 'number', disabled, ...state, onEdit: edit, onReset: () => props.resetField(f.field) }),
          })
        case 'choice':
          return wrap(jsx('div', { children: jsx(P.SegmentedControl, { id, label, value: state.text, disabled, options: f.options.map((o) => ({ value: o, label: t(`${f.field}_${o}`) })), onChange: edit }) }))
        case 'switch':
          return wrap(jsx('div', { children: jsx(P.Switch, { label, checked: state.text === 'true', disabled, onChange: (next) => edit(String(next)) }) }))
        case 'lines':
        case 'pairs':
          return wrap(jsx('textarea', { id, style: S.textarea, spellCheck: false, value: state.text, disabled, onChange: (e) => edit(e.target.value) }))
        case 'flags': {
          const set = new Set(state.text ? state.text.split(',') : [])
          return wrap(jsx('div', {
            style: S.flags,
            children: f.options.map((o) => jsx(P.Checkbox, {
              label: t(`${f.field}_${o}`),
              checked: f.inverted ? !set.has(o) : set.has(o),
              disabled,
              onChange: (checked) => {
                const on = f.inverted ? !checked : checked
                if (on) set.add(o)
                else set.delete(o)
                edit([...set].sort().join(','))
              },
            }, o)),
          }))
        }
        default:
          return null
      }
    }

    function Page(props) {
      const { t } = props
      const ft = (key) => t(`form_${key}`)
      const state = props.usePage((snapshot) => snapshot)
      if (props.view === 'summary') return t('summary')
      const disabled = !state.writable
      return jsx(P.SettingsForm, {
        labels: { unavailable: ft('unavailable'), readOnly: ft('readOnly'), saveFailed: ft('saveFailed'), save: ft('save'), saving: ft('saving') },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: FIELDS.map((f, i) => jsx(Field, { f, state: state.fields[f.field], props, disabled, first: i === 0, t, ft }, f.field)),
      })
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const dictionary = (lang) => ({ ...COPY[lang], ...Object.fromEntries(Object.entries(FORM_COPY[lang]).map(([k, v]) => [`form_${k}`, v])) })
      ctx.effect(() => ctx.locale.register(NS, { en: dictionary('en'), zh: dictionary('zh') }), `${PACKAGE}: dictionaries`)
      const form = new P.SettingsFormModel(ctx.configForms.get(ENTRY), FIELDS.map((f) => SPECS[f.kind](f)))
      const store = form.bind(() => ({ ...form.shell(), fields: Object.fromEntries(FIELDS.map((f) => [f.field, form.field(f.field)])) }))
      ctx.effect(() => () => form.dispose(), `${PACKAGE}: form`)
      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        locale: NS,
        inject: () => ({ hooks: { page: store }, ...form.actions() }),
      }, Page))), `${PACKAGE}: settings page`)
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
