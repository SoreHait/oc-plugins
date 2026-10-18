import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"

// Replaces the builtin `opencode.sidebar.context` panel in place: desired
// plugins are keyed by id, so an external plugin with the same id overwrites
// the builtin entry while keeping its sidebar position (and the builtin remains
// as the automatic fallback when this plugin fails to load).
const BAR_CELLS = 25
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function compact(value: number) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M"
  if (value >= 1_000) return Math.round(value / 1_000) + "k"
  return String(Math.round(value))
}

function price(value: number) {
  return String(Number(value.toFixed(4)))
}

// Mirrors the builtin Context panel: newest assistant usage after the latest
// completed compaction and before an optional revert boundary.
function lastUsage(messages: ReadonlyArray<any>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  let compaction = -1
  for (let index = 0; index < end; index++) {
    const message = messages[index]
    if (message.type === "compaction" && message.status === "completed") compaction = index
  }
  for (let index = end - 1; index > compaction; index--) {
    const message = messages[index]
    if (message.type === "assistant" && message.tokens) return message
  }
  return undefined
}

function ContextPanel(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const location = () =>
    props.context.data.session.get(props.sessionID)?.location ??
    props.context.location ??
    props.context.data.location.default()

  // Auto-compaction is not part of the model metadata: its trigger comes from
  // the merged config. Plugins only reach it through the client API, so load
  // the document entries and mirror the core merge (last defined field wins).
  const [compaction, setCompaction] = createSignal<{ auto: boolean; buffer: number | undefined }>({
    auto: true,
    buffer: undefined,
  })
  let configRequest = 0
  createEffect(() => {
    const directory = location().directory
    const request = ++configRequest
    void props.context.client.config
      .get({ location: { directory } })
      .then((entries) => {
        if (request !== configRequest) return
        let auto = true
        let buffer: number | undefined
        for (const entry of entries) {
          if (entry.type !== "document" || !entry.info.compaction) continue
          auto = entry.info.compaction.auto ?? auto
          buffer = entry.info.compaction.buffer ?? buffer
        }
        setCompaction({ auto, buffer })
      })
      .catch(() => {})
  })

  createEffect(() => {
    void props.context.data.location.model.sync(location())
  })

  const models = createMemo(() => props.context.data.location.model.list(location()) ?? [])
  const selected = createMemo(() => {
    const current = props.context.ui.model.current()
    if (!current) return undefined
    return models().find((model) => model.providerID === current.providerID && model.id === current.modelID)
  })

  const usage = createMemo(() => {
    const messages = props.context.data.session.message.list(props.sessionID)
    const boundary = props.context.data.session.get(props.sessionID)?.revert?.messageID
    const last = lastUsage(messages, boundary)
    if (!last) {
      const model = selected()
      const full = model?.limit.context
      const input = model?.limit.input
      return { tokens: 0, full, input, scale: input || full, percent: 0 }
    }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = models().find(
      (item) => item.providerID === last.model?.providerID && item.id === last.model?.id,
    )
    // Prefer the window of the currently selected model so switching models
    // updates the limit immediately; fall back to the model behind the usage.
    const active = selected() ?? model
    const full = active?.limit.context
    const input = active?.limit.input
    // The bar measures against the window the provider actually accepts: the
    // input limit when present, otherwise the full context window.
    const scale = input || full
    // Two decimals keep small usage deltas visible in the sub-line and align
    // the bar fill with the displayed percent.
    const percent = scale ? Math.round((tokens / scale) * 10_000) / 100 : undefined
    return { tokens, full, input, scale, percent }
  })

  const color = () => {
    const value = usage()
    const ceiling = threshold()
    if (ceiling === undefined) return theme.text.muted
    if (value.tokens >= ceiling) return theme.text.feedback.error.base
    if (value.tokens >= ceiling * 0.8) return theme.text.feedback.warning.base
    return theme.text.feedback.success.base
  }
  const filled = () => {
    const percent = usage().percent
    if (percent === undefined) return 0
    // Used-based bar: any positive slice lights its cell, so round up.
    return Math.max(0, Math.min(BAR_CELLS, Math.ceil((percent / 100) * BAR_CELLS)))
  }
  // Mirrors SessionCompaction.calculateCeiling: the bar's window (input limit
  // when present, otherwise the full context) minus the configured or derived
  // reserve. With auto-compaction off there is no real trigger, so use an
  // assumed 90% ceiling only for the warning bands (no tick is drawn).
  const threshold = createMemo(() => {
    const scale = usage().scale
    if (!scale || scale <= 0) return undefined
    const settings = compaction()
    if (!settings.auto) return scale * 0.9
    const reserve = settings.buffer ?? Math.max(Math.floor(scale * 0.1), scale >= 32_000 ? 16_000 : 0)
    return scale - reserve
  })
  const thresholdPercent = createMemo(() => {
    const ceiling = threshold()
    const scale = usage().scale
    if (ceiling === undefined || !scale || scale <= 0) return undefined
    return Math.round((ceiling / scale) * 10_000) / 100
  })
  const marker = createMemo(() => {
    if (!compaction().auto) return undefined
    const percent = thresholdPercent()
    if (percent === undefined) return undefined
    return Math.max(0, Math.min(BAR_CELLS - 1, Math.floor((percent / 100) * BAR_CELLS)))
  })
  const bar = createMemo(() => {
    const count = filled()
    const mark = marker()
    const active = color()
    const segments: Array<{ text: string; color: string }> = []
    const add = (text: string, color: string) => {
      if (text.length > 0) segments.push({ text, color })
    }
    if (mark === undefined) {
      add("█".repeat(count), active)
      add("░".repeat(BAR_CELLS - count), theme.text.muted)
      return segments
    }
    add("█".repeat(Math.min(count, mark)), active)
    add("░".repeat(Math.max(0, mark - count)), theme.text.muted)
    add("┃", theme.text.base)
    add("█".repeat(Math.max(0, count - mark - 1)), active)
    add("░".repeat(Math.max(0, BAR_CELLS - Math.max(count, mark + 1))), theme.text.muted)
    return segments
  })
  const window = () => {
    const value = usage()
    const used = Math.round(value.tokens).toLocaleString()
    return value.scale === undefined ? used : `${used} / ${compact(value.scale)}`
  }
  const fullText = () => {
    const value = usage()
    return value.input === undefined || value.full === undefined ? "" : `full ${compact(value.full)}`
  }
  const compactText = () => {
    if (!compaction().auto) return "auto compact disabled"
    const ceiling = threshold()
    const percent = thresholdPercent()
    if (ceiling === undefined || percent === undefined) return ""
    return `compact @ ${compact(ceiling)} ${percent.toFixed(2)}%`
  }
  const shorthand = () => {
    const model = selected()
    if (!model) return undefined
    const initials = (list: string[]) => list.map((item) => item[0]?.toUpperCase() ?? "").join("")
    const input = initials(model.capabilities.input)
    const output = initials(model.capabilities.output)
    if (!input && !output) return undefined
    return `${input}-${output}`
  }
  const variants = () => props.context.ui.model.variant.list()
  const activeVariant = () => props.context.ui.model.current()?.variant
  const cost = () => props.context.data.session.cost(props.sessionID)
  const pricing = createMemo(() =>
    (selected()?.cost ?? [])
      .map((entry) => {
        const parts: string[] = []
        if (entry.input > 0) parts.push(`i${price(entry.input)}`)
        if (entry.output > 0) parts.push(`o${price(entry.output)}`)
        if (entry.cache.read > 0) parts.push(`cr${price(entry.cache.read)}`)
        if (entry.cache.write > 0) parts.push(`cw${price(entry.cache.write)}`)
        return { tier: entry.tier, value: parts.join("·") }
      })
      .filter((entry) => entry.value.length > 0),
  )
  const showBilling = () => pricing().length > 0 || cost() > 0

  return (
    <Show when={selected()}>
      <box>
        <text fg={theme.text.base}>
          <b>Context & Model</b>
        </text>
        <box flexDirection="row" gap={1} justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text fg={color()}>•</text>
            <text fg={theme.text.base}>ctx</text>
          </box>
          <text>
            <For each={bar()}>
              {(segment) => <span style={{ fg: segment.color }}>{segment.text}</span>}
            </For>
          </text>
        </box>
        <box flexDirection="row" gap={1} justifyContent="space-between" paddingLeft={2}>
          <text fg={theme.text.muted}>{window()}</text>
          <text fg={theme.text.muted}>{usage().percent === undefined ? "" : usage().percent.toFixed(2) + "%"}</text>
        </box>
        <Show when={fullText() || compactText()}>
          <box
            flexDirection="row"
            gap={1}
            justifyContent={fullText() ? "space-between" : "flex-end"}
            paddingLeft={2}
          >
            <text fg={theme.text.muted}>{fullText()}</text>
            <text fg={theme.text.muted}>{compactText()}</text>
          </box>
        </Show>
        <box flexDirection="row" gap={1} justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.feedback.success.base}>•</text>
            <text fg={theme.text.base}>modalities & variants</text>
          </box>
          <text fg={theme.text.muted} wrapMode="none">
            {shorthand() ?? ""}
          </text>
        </box>
        <Show when={variants().length > 0}>
          <box flexDirection="row" justifyContent="space-evenly" minWidth={0} paddingLeft={2}>
            <For each={variants()}>
              {(id) => (
                <Show
                  when={id === activeVariant()}
                  fallback={
                    <text fg={theme.text.muted} wrapMode="none">
                      {id}
                    </text>
                  }
                >
                  <text fg={theme.text.base} wrapMode="none">
                    <b>{id}</b>
                  </text>
                </Show>
              )}
            </For>
          </box>
        </Show>
        <Show when={showBilling()}>
          <box flexDirection="row" gap={1} justifyContent="space-between">
            <box flexDirection="row" gap={1}>
              <text fg={theme.text.feedback.success.base}>•</text>
              <text fg={theme.text.base}>billing</text>
            </box>
            <text fg={theme.text.muted}>{money.format(cost())} spent</text>
          </box>
          <For each={pricing()}>
            {(entry) => (
              <box flexDirection="row" gap={1} justifyContent="space-between" paddingLeft={2}>
                <text fg={theme.text.muted}>{entry.tier ? ">" + compact(entry.tier.size) : "price"}</text>
                <text fg={theme.text.muted} wrapMode="none">
                  {entry.value}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <ContextPanel context={context} sessionID={input.sessionID} />,
    })
    return () => unregister()
  },
})
