/**
 * First run: point this install at a server and build what it needs.
 *
 * Deliberately linear and deliberately short. The only question the app cannot
 * answer for itself is where the models are, and getting that wrong produces an
 * install that looks finished and does nothing — so the host is verified before
 * anything is written, and the wizard will not move on from a host that answers
 * nothing.
 *
 * Everything after that step is skippable. A setup that demands a Duffel token
 * before it will finish is one people abandon halfway; the credentials step
 * says what each field unlocks, and the same fields live in Settings
 * afterwards so nothing entered here is a one-time chance.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import type {
  CredentialState,
  ModelReport,
  ProbeResult,
  ProvisionProgress,
  ServerCredentials,
  SetupServer,
  SetupState
} from '@shared/setup'
import './setup.css'

type Step = 'server' | 'model' | 'servers' | 'credentials' | 'installing' | 'done'

interface Props {
  onFinished: () => void
}

/**
 * One cast, here, rather than at every call site.
 *
 * `window.harness.invoke` is precisely typed per channel, which is right
 * everywhere else and unhelpful in a component that walks a list of channels.
 * Failures return null: on a first run there is no store to log through and
 * nothing useful to do with a thrown error except show the step again.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  const raw = window.harness.invoke as unknown as (c: string, ...a: unknown[]) => Promise<unknown>
  try {
    return (await raw(channel, ...args)) as T
  } catch {
    return null
  }
}

export default function SetupWizard({ onFinished }: Props): JSX.Element {
  const [step, setStep] = useState<Step>('server')
  const [state, setState] = useState<SetupState | null>(null)

  /* Step 1 */
  const [host, setHost] = useState('127.0.0.1')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)

  /* Step 2-3 */
  const [modelId, setModelId] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  /* Step 4-5 */
  const [comfy, setComfy] = useState<ModelReport | null>(null)
  const [progress, setProgress] = useState<Record<string, ProvisionProgress['phase']>>({})
  const [failures, setFailures] = useState<{ id: string; error: string }[]>([])

  useEffect(() => {
    void (async () => {
      const s = await invoke<SetupState>('setup:state')
      if (!s) return
      setState(s)
      setChosen(new Set(s.servers.filter((x) => x.tier === 'core').map((x) => x.id)))
    })()
  }, [])

  useEffect(() => {
    const off = window.harness.on('event:setupProgress', (p: ProvisionProgress) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.phase }))
    })
    return off
  }, [])

  const runProbe = useCallback(async () => {
    setProbing(true)
    setProbe(null)
    const result = await invoke<ProbeResult>('setup:probe', host)
    setProbing(false)
    if (!result) return
    setProbe(result)
    /* A model already in memory is the one to offer: loading another costs
       minutes and the person doing setup has not asked for that. */
    if (result.api) setModelId(result.models.find((m) => m.loaded)?.id ?? result.models[0]?.id ?? null)
  }, [host])

  const install = useCallback(async () => {
    if (!probe) return
    setStep('installing')
    const ids = [...chosen]
    const res = await invoke<{ installed: string[]; failed: { id: string; error: string }[] }>(
      'setup:install',
      ids
    )
    setFailures(res?.failed ?? [])
    await invoke('setup:finish', {
      baseUrl: probe.baseUrl,
      nativeApiUrl: probe.nativeApiUrl,
      modelId,
      workspaceRoot: null
    })
    setState(await invoke<SetupState>('setup:state'))
    setStep('done')
  }, [chosen, modelId, probe])

  const servers = state?.servers ?? []
  const wantsComfy = useMemo(
    () => [...chosen].some((id) => id === 'comfy-image' || id === 'comfy-audio'),
    [chosen]
  )

  return (
    <div className="wz">
      <div className="wz-card">
        <header className="wz-head">
          <span className="wz-glyph">⌘</span>
          <div>
            <h1 className="wz-title">CaptainLlama</h1>
            <p className="wz-sub">{SUBTITLE[step]}</p>
          </div>
          <Dots step={step} />
        </header>

        {step === 'server' ? (
          <ServerStep
            host={host}
            setHost={setHost}
            probing={probing}
            probe={probe}
            onProbe={runProbe}
            onNext={() => setStep('model')}
          />
        ) : null}

        {step === 'model' && probe ? (
          <ModelStep
            probe={probe}
            modelId={modelId}
            setModelId={setModelId}
            onBack={() => setStep('server')}
            onNext={() => setStep('servers')}
          />
        ) : null}

        {step === 'servers' ? (
          <ServersStep
            servers={servers}
            chosen={chosen}
            setChosen={setChosen}
            onBack={() => setStep('model')}
            onNext={() => setStep('credentials')}
          />
        ) : null}

        {step === 'credentials' && state ? (
          <CredentialsStep
            spec={state.credentials}
            states={state.states}
            chosen={chosen}
            wantsComfy={wantsComfy}
            comfy={comfy}
            onCheckComfy={async (h) => setComfy(await invoke<ModelReport>('setup:checkComfyModels', h))}
            onSet={async (serverId, key, value) => {
              const next = await invoke<CredentialState[]>('setup:setCredential', serverId, key, value)
              if (next && state) setState({ ...state, states: next })
            }}
            onBack={() => setStep('servers')}
            onNext={install}
          />
        ) : null}

        {step === 'installing' ? <InstallStep chosen={[...chosen]} progress={progress} /> : null}

        {step === 'done' ? (
          <DoneStep failures={failures} installed={[...chosen].length - failures.length} onFinish={onFinished} />
        ) : null}
      </div>
    </div>
  )
}

const SUBTITLE: Record<Step, string> = {
  server: 'Where are your models?',
  model: 'Which one should it start with?',
  servers: 'What should it be able to do?',
  credentials: 'Anything it needs from you',
  installing: 'Building the tools',
  done: 'Ready'
}

const ORDER: Step[] = ['server', 'model', 'servers', 'credentials', 'installing', 'done']

function Dots({ step }: { step: Step }): JSX.Element {
  const at = ORDER.indexOf(step)
  return (
    <div className="wz-dots" aria-label={`Step ${at + 1} of ${ORDER.length}`}>
      {ORDER.map((s, i) => (
        <span key={s} className={i <= at ? 'wz-dot is-on' : 'wz-dot'} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ServerStep({
  host,
  setHost,
  probing,
  probe,
  onProbe,
  onNext
}: {
  host: string
  setHost: (v: string) => void
  probing: boolean
  probe: ProbeResult | null
  onProbe: () => void
  onNext: () => void
}): JSX.Element {
  return (
    <div className="wz-body">
      <p className="wz-lead">
        CaptainLlama does not run models itself — it talks to a server that does. On the machine
        running LM Studio that is this machine; from anywhere else, use its name on your network.
      </p>
      <div className="wz-row">
        <input
          className="wz-input"
          value={host}
          spellCheck={false}
          placeholder="127.0.0.1"
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onProbe()
          }}
          aria-label="Inference server address"
        />
        <button type="button" className="btn" onClick={onProbe} disabled={probing || host.trim() === ''}>
          {probing ? 'Checking…' : 'Check'}
        </button>
      </div>

      {probe?.api ? (
        <div className="wz-result is-ok">
          <strong>Answered in {probe.latencyMs} ms.</strong>{' '}
          {probe.models.length} model{probe.models.length === 1 ? '' : 's'} available.
          {/* Not fatal, and worth saying rather than silently losing the meter. */}
          {probe.native ? null : (
            <div className="wz-note">
              Its native port did not answer, so the live prefill and decode readouts will stay
              empty. Everything else works.
            </div>
          )}
        </div>
      ) : null}

      {probe && !probe.api ? <div className="wz-result is-bad">{probe.error}</div> : null}

      <div className="wz-actions">
        <span />
        <button type="button" className="btn btn-primary" disabled={!probe?.api} onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  )
}

function ModelStep({
  probe,
  modelId,
  setModelId,
  onBack,
  onNext
}: {
  probe: ProbeResult
  modelId: string | null
  setModelId: (v: string) => void
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  return (
    <div className="wz-body">
      <p className="wz-lead">
        This is only the starting point — every workflow can use a different model, and you can
        change it whenever you like.
      </p>
      <ul className="wz-list">
        {probe.models.map((m) => (
          <li key={m.id}>
            <label className={m.id === modelId ? 'wz-pick is-on' : 'wz-pick'}>
              <input
                type="radio"
                name="model"
                checked={m.id === modelId}
                onChange={() => setModelId(m.id)}
              />
              <span className="wz-pick-name">{m.id}</span>
              {m.loaded ? <span className="wz-tag">in memory</span> : null}
              {m.contextLength ? (
                <span className="wz-dim">{Math.round(m.contextLength / 1000)}k context</span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
      <Nav onBack={onBack} onNext={onNext} nextLabel="Continue" />
    </div>
  )
}

function ServersStep({
  servers,
  chosen,
  setChosen,
  onBack,
  onNext
}: {
  servers: SetupServer[]
  chosen: Set<string>
  setChosen: (s: Set<string>) => void
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  const toggle = (id: string): void => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChosen(next)
  }
  const groups: { tier: 'core' | 'optional'; title: string; hint: string }[] = [
    { tier: 'core', title: 'Included', hint: 'Everything needed for reading, writing and browsing.' },
    { tier: 'optional', title: 'Extras', hint: 'Each needs something more — say what, before you tick it.' }
  ]
  return (
    <div className="wz-body">
      {groups.map((g) => (
        <section key={g.tier} className="wz-group">
          <div className="wz-group-head">
            <span className="section-label">{g.title}</span>
            <span className="wz-dim">{g.hint}</span>
          </div>
          <ul className="wz-list">
            {servers
              .filter((s) => s.tier === g.tier)
              .map((s) => (
                <li key={s.id}>
                  <label className={chosen.has(s.id) ? 'wz-pick is-on' : 'wz-pick'}>
                    <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="wz-pick-name">{s.label}</span>
                    {s.blurb ? <span className="wz-dim">{s.blurb}</span> : null}
                    {s.cost ? <span className="wz-tag is-warn">{s.cost}</span> : null}
                    {s.requires ? <span className="wz-tag">needs {s.requires}</span> : null}
                  </label>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <Nav onBack={onBack} onNext={onNext} nextLabel="Continue" />
    </div>
  )
}

function CredentialsStep({
  spec,
  states,
  chosen,
  wantsComfy,
  comfy,
  onCheckComfy,
  onSet,
  onBack,
  onNext
}: {
  spec: ServerCredentials[]
  states: CredentialState[]
  chosen: Set<string>
  wantsComfy: boolean
  comfy: ModelReport | null
  onCheckComfy: (host: string) => Promise<void>
  onSet: (serverId: string, key: string, value: string) => Promise<void>
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  const [comfyHost, setComfyHost] = useState('http://127.0.0.1:8188')
  const [checking, setChecking] = useState(false)

  /* Only ask about servers actually being installed, and skip anything the
     wizard already filled in from the verified inference server. */
  const relevant = spec
    .filter((s) => chosen.has(s.serverId))
    .map((s) => ({ ...s, fields: s.fields.filter((f) => !f.derivedFromServer) }))
    .filter((s) => s.fields.length > 0)

  return (
    <div className="wz-body">
      <p className="wz-lead">
        All optional. Each one says what still works without it, and you can add any of these later
        from Settings.
      </p>

      {relevant.length === 0 ? (
        <p className="wz-dim">Nothing you picked needs anything from you.</p>
      ) : null}

      {relevant.map((server) => (
        <section key={server.serverId} className="wz-group">
          <div className="wz-group-head">
            <span className="section-label">{server.label}</span>
          </div>
          {server.fields.map((f) => {
            const st = states.find((s) => s.serverId === server.serverId && s.key === f.key)
            return (
              <div key={f.key} className="wz-field">
                <label className="wz-field-label" htmlFor={`${server.serverId}-${f.key}`}>
                  {f.label}
                  {st?.set ? (
                    <span className="wz-tag is-ok">
                      {f.kind === 'secret' ? `set · ${st.length} chars` : 'set'}
                    </span>
                  ) : null}
                </label>
                <input
                  id={`${server.serverId}-${f.key}`}
                  className="wz-input"
                  type={f.kind === 'secret' ? 'password' : 'text'}
                  spellCheck={false}
                  placeholder={f.placeholder ?? ''}
                  defaultValue={f.kind === 'secret' ? '' : (st?.value ?? '')}
                  onBlur={(e) => void onSet(server.serverId, f.key, e.target.value.trim())}
                />
                <p className="wz-without">{f.withoutIt}</p>
              </div>
            )
          })}
        </section>
      ))}

      {wantsComfy ? (
        <section className="wz-group">
          <div className="wz-group-head">
            <span className="section-label">ComfyUI models</span>
            <span className="wz-dim">
              These servers start fine without them and fail at generation time, so it is worth
              checking now.
            </span>
          </div>
          <div className="wz-row">
            <input
              className="wz-input"
              value={comfyHost}
              spellCheck={false}
              onChange={(e) => setComfyHost(e.target.value)}
              aria-label="ComfyUI address"
            />
            <button
              type="button"
              className="btn"
              disabled={checking}
              onClick={() => {
                setChecking(true)
                void onCheckComfy(comfyHost).finally(() => setChecking(false))
              }}
            >
              {checking ? 'Checking…' : 'Check models'}
            </button>
          </div>
          {comfy ? <ComfyReport report={comfy} /> : null}
        </section>
      ) : null}

      <Nav onBack={onBack} onNext={onNext} nextLabel="Install" />
    </div>
  )
}

function ComfyReport({ report }: { report: ModelReport }): JSX.Element {
  if (!report.reachable) {
    return <div className="wz-result is-bad">Could not reach it: {report.error}</div>
  }
  if (report.missing.length === 0) {
    return (
      <div className="wz-result is-ok">
        All {report.present.length} required models are there.
      </div>
    )
  }
  return (
    <div className="wz-result is-warn">
      <strong>
        {report.missing.length} model{report.missing.length === 1 ? '' : 's'} missing.
      </strong>
      <ul className="wz-missing">
        {report.missing.map((m) => (
          <li key={m.where}>
            <code>{m.where}</code>
            <span className="wz-dim">for {m.feature}</span>
          </li>
        ))}
      </ul>
      {/* Not a blocker: everything else installs, and the models can be
          dropped in later without touching this app. */}
      <p className="wz-without">
        You can install these into ComfyUI later — nothing else is held up by it.
      </p>
    </div>
  )
}

function InstallStep({
  chosen,
  progress
}: {
  chosen: string[]
  progress: Record<string, ProvisionProgress['phase']>
}): JSX.Element {
  const PHASE: Record<ProvisionProgress['phase'], string> = {
    copying: 'copying',
    'creating-env': 'creating environment',
    installing: 'installing packages',
    done: 'ready',
    failed: 'failed'
  }
  return (
    <div className="wz-body">
      <p className="wz-lead">
        Building each server against the Python that ships with the app. No network needed.
      </p>
      <ul className="wz-list">
        {chosen.map((id) => {
          const phase = progress[id]
          return (
            <li key={id} className="wz-progress">
              <span className={phase === 'done' ? 'wz-tick is-on' : 'wz-tick'}>
                {phase === 'done' ? '✓' : phase === 'failed' ? '✕' : '·'}
              </span>
              <span className="wz-pick-name">{id}</span>
              <span className="wz-dim">{phase ? PHASE[phase] : 'waiting'}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function DoneStep({
  failures,
  installed,
  onFinish
}: {
  failures: { id: string; error: string }[]
  installed: number
  onFinish: () => void
}): JSX.Element {
  return (
    <div className="wz-body">
      <p className="wz-lead">
        {installed} server{installed === 1 ? '' : 's'} installed.
        {failures.length > 0
          ? ' Some did not, which does not affect the rest.'
          : ' Pick a workspace folder in the Code panel and you are ready.'}
      </p>
      {failures.length > 0 ? (
        <ul className="wz-list">
          {failures.map((f) => (
            <li key={f.id} className="wz-result is-bad">
              <strong>{f.id}</strong> {f.error}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="wz-actions">
        <span />
        <button type="button" className="btn btn-primary" onClick={onFinish}>
          Start
        </button>
      </div>
    </div>
  )
}

function Nav({
  onBack,
  onNext,
  nextLabel
}: {
  onBack: () => void
  onNext: () => void
  nextLabel: string
}): JSX.Element {
  return (
    <div className="wz-actions">
      <button type="button" className="btn btn-ghost" onClick={onBack}>
        Back
      </button>
      <button type="button" className="btn btn-primary" onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  )
}
