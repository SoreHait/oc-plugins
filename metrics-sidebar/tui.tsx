import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"

const TICK_MS = 250
const WINDOW_MS = 3_000
const MAX_SAMPLES = 240
const MIN_ELAPSED_MS = 200
const RECENT_MS = 1_000

function familyIDs(context: Plugin.Context, sessionID: string) {
  const ids = context.data.session.family(sessionID)
  return ids.length > 0 ? ids : [sessionID]
}

function compact(value: number) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M"
  if (value >= 1_000) return Math.round(value / 1_000) + "k"
  return String(value)
}

function formatElapsed(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
}

function formatTokens(current: number | undefined, total: number) {
  if (current === undefined) return compact(total)
  return `${compact(current)} (${compact(total)})`
}

function MetricsPanel(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const family = createMemo(() => familyIDs(props.context, props.sessionID))
  const tokens = createMemo(() => {
    const totals = { input: 0, output: 0 }
    for (const id of family()) {
      const usage = props.context.data.session.get(id)?.tokens
      if (!usage) continue
      totals.input += usage.input
      totals.output += usage.output + usage.reasoning
    }
    return totals
  })
  const running = createMemo(() => family().some((id) => props.context.data.session.status(id) === "running"))
  const turn = createMemo(() => {
    let startedAt: number | undefined
    for (const id of family()) {
      for (const message of props.context.data.session.message.list(id)) {
        if (message.type !== "user") continue
        const created = message.time.created
        if (startedAt === undefined || created > startedAt) startedAt = created
      }
    }
    if (startedAt === undefined) return undefined
    const totals = { startedAt, input: 0, output: 0 }
    for (const id of family()) {
      for (const message of props.context.data.session.message.list(id)) {
        if (message.time.created <= startedAt) continue
        const usage = "tokens" in message ? message.tokens : undefined
        if (!usage) continue
        totals.input += usage.input
        totals.output += usage.output + usage.reasoning
      }
    }
    return totals
  })

  const [now, setNow] = createSignal(Date.now())
  const [chars, setChars] = createSignal(0)
  const [charsPerToken, setCharsPerToken] = createSignal(4)
  const [samples, setSamples] = createSignal<Array<{ t: number; chars: number; total: number }>>([])
  const [frozen, setFrozen] = createSignal<number>()
  const [frozenElapsed, setFrozenElapsed] = createSignal<number>()
  let observedStart: number | undefined

  // Streaming text, thinking and tool-argument deltas are the live volume
  // signal; the session token counter only lands in bursts at step boundaries.
  const stopText = props.context.data.on("session.text.delta", (event) => {
    if (!family().includes(event.data.sessionID)) return
    setChars((value) => value + event.data.delta.length)
  })
  const stopReasoning = props.context.data.on("session.reasoning.delta", (event) => {
    if (!family().includes(event.data.sessionID)) return
    setChars((value) => value + event.data.delta.length)
  })
  const stopToolInput = props.context.data.on("session.tool.input.delta", (event) => {
    if (!family().includes(event.data.sessionID)) return
    setChars((value) => value + event.data.delta.length)
  })

  // A real run start gives the elapsed row a sane fallback while a prompt whose
  // message row has not synced yet would otherwise show the previous turn's age.
  const rootID = props.context.data.session.root(props.sessionID)
  const stopExecution = props.context.data.on("session.execution.started", (event) => {
    if (event.data.sessionID !== rootID) return
    observedStart = Date.now()
  })

  // Recalibrate characters-per-token from real step accounting so CJK and
  // tool-heavy turns estimate as well as plain English prose.
  let calibrationTokens = untrack(() => tokens().output)
  let calibrationChars = 0
  let calibrations = 0
  createEffect(() => {
    const total = tokens().output
    if (total <= calibrationTokens) return
    const deltaTokens = total - calibrationTokens
    const deltaChars = untrack(chars) - calibrationChars
    if (deltaChars > 0) {
      const ratio = deltaChars / deltaTokens
      if (ratio >= 0.25 && ratio <= 16) {
        setCharsPerToken((previous) => (calibrations === 0 ? ratio : previous * 0.5 + ratio * 0.5))
        calibrations++
      }
    }
    calibrationTokens = total
    calibrationChars = untrack(chars)
  })

  createEffect(() => {
    const sample = { t: now(), chars: untrack(chars), total: untrack(() => tokens().output) }
    setSamples((list) => [...list.slice(-(MAX_SAMPLES - 1)), sample])
  })
  const timer = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => {
    clearInterval(timer)
    stopText()
    stopReasoning()
    stopToolInput()
    stopExecution()
  })

  const measured = createMemo(() => {
    const list = samples().filter((sample) => sample.t >= gapAt)
    if (list.length < 2) return undefined
    const latest = list[list.length - 1]
    const start = list.find((sample) => latest.t - sample.t <= WINDOW_MS) ?? list[0]
    const elapsed = latest.t - start.t
    if (elapsed < MIN_ELAPSED_MS) return undefined
    const charsPerSecond = ((latest.chars - start.chars) / elapsed) * 1_000
    if (charsPerSecond > 0) return charsPerSecond / charsPerToken()
    // Fallback for providers that do not stream deltas.
    return Math.max(0, ((latest.total - start.total) / elapsed) * 1_000)
  })

  const recent = createMemo(() => {
    const list = samples()
    if (list.length < 2) return undefined
    const latest = list[list.length - 1]
    const start = list.find((sample) => latest.t - sample.t <= RECENT_MS) ?? list[0]
    const elapsed = latest.t - start.t
    if (elapsed < MIN_ELAPSED_MS) return undefined
    return ((latest.chars - start.chars) / elapsed) * 1_000
  })

  // A resumed burst measures from its own restart point so pause samples never
  // dilute the fresh rate; gaps freeze the last reading behind a [p] marker.
  let gapAt = 0
  let wasStreaming = false
  // True once this run actually produced output; false while a fresh run is
  // still awaiting its first token. Mounting into a running session starts true.
  let hasStreamed = untrack(() => running())
  createEffect(() => {
    const streaming = (recent() ?? 0) > 0
    if (running() && streaming) {
      if (!wasStreaming) gapAt = Date.now()
      hasStreamed = true
    }
    wasStreaming = streaming
  })

  // Last reading while output was still growing — backs the frozen gap display
  // and the stop freeze, and bridges the first tick after a resume.
  let lastReading: number | undefined
  createEffect(() => {
    const list = samples()
    if (list.length < 2) return
    if (list[list.length - 1].chars <= list[list.length - 2].chars) return
    const value = untrack(measured)
    if (value !== undefined && value > 0) lastReading = value
  })

  // A new run measures from scratch; a finished run freezes its last reading.
  let wasRunning = untrack(() => running())
  createEffect(() => {
    const isRunning = running()
    if (isRunning === wasRunning) return
    if (isRunning) {
      hasStreamed = false
      lastReading = undefined
      gapAt = 0
      setSamples([])
    } else {
      const value = lastReading ?? untrack(measured)
      if (value !== undefined) setFrozen(value)
      const time = untrack(liveElapsed)
      if (time !== undefined) setFrozenElapsed(time)
    }
    wasRunning = isRunning
  })

  const liveElapsed = createMemo(() => {
    const startedAt = turn()?.startedAt
    const current = now()
    if (startedAt === undefined) return observedStart === undefined ? undefined : current - observedStart
    // A stale prompt time (message store lagging behind a fresh run) would show
    // a huge value for a frame; fall back to when the run was observed.
    if (observedStart !== undefined && startedAt < observedStart - 60_000) return current - observedStart
    return current - startedAt
  })

  const elapsed = createMemo(() => {
    const isRunning = running()
    const value = isRunning ? liveElapsed() : frozenElapsed()
    if (value === undefined) return { text: "idle", color: theme.text.muted }
    return {
      text: formatElapsed(value),
      color: isRunning ? theme.text.feedback.success.base : theme.text.muted,
    }
  })

  const tps = createMemo(() => {
    if (!running()) {
      const value = frozen()
      if (value === undefined) return { text: "idle", color: theme.text.muted }
      return { text: value.toFixed(1) + " tok/s", color: theme.text.muted }
    }
    if ((recent() ?? 0) > 0) {
      const value = measured() ?? lastReading
      if (value === undefined) return { text: "measuring...", color: theme.text.muted }
      return {
        text: value.toFixed(1) + " tok/s",
        color: value > 0 ? theme.text.feedback.success.base : theme.text.muted,
      }
    }
    // No output in the recent window: waiting on a tool or transport. Keep the
    // last reading visible but gray, prefixed with [p]; only a run that never
    // streamed (or a plugin mounted mid-gap without a reading yet) falls back
    // to text.
    if (hasStreamed && recent() !== undefined) {
      if (lastReading !== undefined)
        return { text: "[p] " + lastReading.toFixed(1) + " tok/s", color: theme.text.muted }
      return { text: "paused", color: theme.text.muted }
    }
    return { text: "measuring...", color: theme.text.muted }
  })

  return (
    <box>
      <text fg={theme.text.base}>
        <b>Metrics</b>
      </text>
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={tps().color}>•</text>
          <text fg={theme.text.base}>TPS</text>
        </box>
        <text fg={tps().color}>{tps().text}</text>
      </box>
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={elapsed().color}>•</text>
          <text fg={theme.text.base}>Elapsed</text>
        </box>
        <text fg={elapsed().color}>{elapsed().text}</text>
      </box>
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.feedback.success.base}>•</text>
          <text fg={theme.text.base}>In</text>
        </box>
        <text fg={theme.text.muted}>{formatTokens(turn()?.input, tokens().input)}</text>
      </box>
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.feedback.success.base}>•</text>
          <text fg={theme.text.base}>Out</text>
        </box>
        <text fg={theme.text.muted}>{formatTokens(turn()?.output, tokens().output)}</text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "metrics-sidebar",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <MetricsPanel context={context} sessionID={input.sessionID} />,
    })
    return () => unregister()
  },
})
