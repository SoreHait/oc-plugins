import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"

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
    if (!last) return { tokens: 0, limit: selected()?.limit.context, percent: 0 }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = models().find(
      (item) => item.providerID === last.model?.providerID && item.id === last.model?.id,
    )
    // Prefer the window of the currently selected model so switching models
    // updates the limit immediately; fall back to the model behind the usage.
    const limit = selected()?.limit.context ?? model?.limit.context
    // Two decimals keep small usage deltas visible in the sub-line and align
    // the bar fill with the displayed percent.
    const percent = limit ? Math.round((tokens / limit) * 10_000) / 100 : undefined
    return { tokens, limit, percent }
  })

  const color = () => {
    const percent = usage().percent
    if (percent === undefined) return theme.text.muted
    if (percent > 80) return theme.text.feedback.error.base
    if (percent > 60) return theme.text.feedback.warning.base
    return theme.text.feedback.success.base
  }
  const filled = () => {
    const percent = usage().percent
    if (percent === undefined) return 0
    // Used-based bar: any positive slice lights its cell, so round up.
    return Math.max(0, Math.min(BAR_CELLS, Math.ceil((percent / 100) * BAR_CELLS)))
  }
  const window = () => {
    const value = usage()
    const used = Math.round(value.tokens).toLocaleString()
    return value.limit === undefined ? used : `${used} / ${compact(value.limit)}`
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
            <span style={{ fg: color() }}>{"█".repeat(filled())}</span>
            <span style={{ fg: theme.text.muted }}>{"░".repeat(BAR_CELLS - filled())}</span>
          </text>
        </box>
        <box flexDirection="row" gap={1} justifyContent="space-between" paddingLeft={2}>
          <text fg={theme.text.muted}>{window()}</text>
          <text fg={theme.text.muted}>{usage().percent === undefined ? "" : usage().percent.toFixed(2) + "%"}</text>
        </box>
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
