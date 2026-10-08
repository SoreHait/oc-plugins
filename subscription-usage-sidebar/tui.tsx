import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
const CHATGPT_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/codex/rate-limit-reset-credits"
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
const REFRESH_MS = 60_000
const BAR_CELLS = 25
const USER_AGENT = "opencode-subscription-usage-sidebar/0.1"

type UsageWindow = {
  label: string
  percent: number
  resetsAt?: number
  exhausted: boolean
}

type ResetCredits = {
  count: number
  expiresAt?: number
}

type UsageSource = {
  title: string
  windows: UsageWindow[]
  credits?: ResetCredits
  error?: string
}

type BalanceRow = {
  label: string
  value: string
  level: "ok" | "low" | "empty"
}

type BalanceSource = {
  title: string
  rows: BalanceRow[]
  error?: string
}

type ChatGPTCredential = {
  access: string
  accountID?: string
  plan?: string
}

function jwtClaim(token: string, name: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())
    return payload?.[name] ?? payload?.["https://api.openai.com/auth"]?.[name]
  } catch {
    return undefined
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : "unavailable"
}

async function goCredential(context: Plugin.Context) {
  try {
    const credentials = await context.client.credential.list()
    const matches = credentials.filter(
      (entry) => entry.integrationID === "opencode-go" && entry.value.type === "key",
    )
    const active = matches.find((entry) => entry.active) ?? matches[matches.length - 1]
    if (active && active.value.type === "key") return active.value.key
  } catch {}
  return process.env.OPENCODE_API_KEY
}

async function deepseekCredential(context: Plugin.Context) {
  try {
    const credentials = await context.client.credential.list()
    const matches = credentials.filter(
      (entry) => entry.integrationID === "deepseek" && entry.value.type === "key",
    )
    const active = matches.find((entry) => entry.active) ?? matches[matches.length - 1]
    if (active && active.value.type === "key") return active.value.key
  } catch {}
  return process.env.DEEPSEEK_API_KEY
}

async function chatgptCredentials(context: Plugin.Context): Promise<ChatGPTCredential[]> {
  const credentials: ChatGPTCredential[] = []
  try {
    const stored = await context.client.credential.list()
    const matches = stored.filter(
      (entry) =>
        entry.integrationID === "openai" &&
        entry.value.type === "oauth" &&
        (entry.value.methodID === "chatgpt-browser" || entry.value.methodID === "chatgpt-headless"),
    )
    const active = matches.find((entry) => entry.active) ?? matches[matches.length - 1]
    if (active && active.value.type === "oauth") {
      const accountID =
        typeof active.value.metadata?.accountID === "string"
          ? active.value.metadata.accountID
          : jwtClaim(active.value.access, "chatgpt_account_id")
      credentials.push({
        access: active.value.access,
        accountID,
        plan: jwtClaim(active.value.access, "chatgpt_plan_type"),
      })
    }
  } catch {}
  // Codex CLI keeps its own ChatGPT login; its tokens query the same windows.
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"))
    const access = auth?.tokens?.access_token
    if (typeof access === "string") {
      const accountID =
        typeof auth?.tokens?.account_id === "string"
          ? auth.tokens.account_id
          : jwtClaim(access, "chatgpt_account_id")
      credentials.push({ access, accountID, plan: jwtClaim(access, "chatgpt_plan_type") })
    }
  } catch {}
  return credentials
}

async function fetchGoUsage(key: string): Promise<UsageSource> {
  const response = await fetch(GO_USAGE_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": USER_AGENT },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: any = await response.json()
  const usage = body?.usage ?? {}
  const windows: UsageWindow[] = []
  for (const [label, item] of [
    ["5h", usage.rolling],
    ["7d", usage.weekly],
    ["30d", usage.monthly],
  ] as Array<[string, any]>) {
    if (!item) continue
    const percent = Number(item.percent ?? 0)
    windows.push({
      label,
      percent,
      resetsAt: typeof item.resetsAt === "string" ? Date.parse(item.resetsAt) : undefined,
      exhausted: item.status === "rate-limited" || percent >= 100,
    })
  }
  return { title: "OpenCode Go", windows }
}

async function fetchChatGPTUsage(auth: ChatGPTCredential): Promise<UsageSource> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.access}`,
    originator: "opencode",
    accept: "application/json",
    "user-agent": USER_AGENT,
  }
  if (auth.accountID) headers["chatgpt-account-id"] = auth.accountID
  const response = await fetch(CHATGPT_USAGE_URL, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: any = await response.json()
  const limit = body?.rate_limit ?? {}
  const windows: UsageWindow[] = []
  for (const item of [limit.primary_window, limit.secondary_window]) {
    if (!item) continue
    const seconds = Number(item.limit_window_seconds ?? 0)
    const percent = Number(item.used_percent ?? 0)
    windows.push({
      label: seconds >= 518_400 ? "7d" : `${Math.round(seconds / 3_600)}h`,
      percent,
      resetsAt: Number(item.reset_at) ? Number(item.reset_at) * 1_000 : undefined,
      exhausted: limit.limit_reached === true || limit.allowed === false || percent >= 100,
    })
  }
  const plan = typeof body?.plan_type === "string" ? body.plan_type : auth.plan
  return { title: chatgptTitle(plan), windows, credits: await fetchChatGPTResetCredits(headers) }
}

async function fetchChatGPTResetCredits(headers: Record<string, string>): Promise<ResetCredits | undefined> {
  try {
    const response = await fetch(CHATGPT_RESET_CREDITS_URL, { headers })
    if (!response.ok) return undefined
    const body: any = await response.json()
    const entries = Array.isArray(body?.credits) ? body.credits : []
    const available = entries.filter((entry: any) => entry?.status === "available")
    const expiries = available
      .map((entry: any) => Date.parse(entry?.expires_at))
      .filter((time: number) => Number.isFinite(time))
    return {
      count: Number(body?.available_count ?? available.length),
      expiresAt: expiries.length > 0 ? Math.min(...expiries) : undefined,
    }
  } catch {
    return undefined
  }
}

function chatgptTitle(plan: unknown) {
  if (typeof plan !== "string" || plan.length === 0) return "ChatGPT"
  if (plan === "prolite") return "ChatGPT Pro Lite"
  return (
    "ChatGPT " +
    plan
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ")
  )
}

async function fetchDeepSeekBalance(key: string): Promise<BalanceSource> {
  const response = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": USER_AGENT },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: any = await response.json()
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const available = body?.is_available === true
  const rows = infos.map((info: any) => {
    const total = Number(info?.total_balance ?? 0)
    const granted = Number(info?.granted_balance ?? 0)
    return {
      label: infos.length > 1 && typeof info?.currency === "string" ? info.currency : "Balance",
      // Show topped-up money, appending the granted part when present.
      value:
        formatAmount(info?.currency, info?.topped_up_balance) +
        (granted > 0 ? ` (+${formatAmount(info?.currency, info?.granted_balance)})` : ""),
      // ¥2 low-balance threshold; empty at zero/negative or when unusable.
      level: !available || total <= 0 ? ("empty" as const) : total < 2 ? ("low" as const) : ("ok" as const),
    }
  })
  return { title: "DeepSeek", rows }
}

function formatAmount(currency: unknown, amount: unknown) {
  const value = amount === undefined || amount === null ? "0" : String(amount)
  if (currency === "CNY") return `¥${value}`
  if (currency === "USD") return `$${value}`
  return `${typeof currency === "string" ? currency + " " : ""}${value}`
}

function remainingPercent(window: UsageWindow) {
  if (window.exhausted) return 0
  return Math.max(0, 100 - window.percent)
}

function formatRemainingPercent(window: UsageWindow) {
  const text = String(window.percent)
  const decimals = text.includes(".") ? text.split(".")[1].length : 0
  return remainingPercent(window).toFixed(decimals) + "%"
}

function windowColor(theme: Plugin.Context["theme"], window: UsageWindow) {
  const remaining = remainingPercent(window)
  if (remaining <= 0) return theme.text.muted
  if (remaining <= 20) return theme.text.feedback.error.base
  if (remaining <= 50) return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

function formatRemaining(resetsAt: number | undefined) {
  if (!resetsAt) return ""
  const remaining = resetsAt - Date.now()
  if (remaining <= 0) return "resetting"
  const minutes = Math.floor(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
}

function expiryDays(expiresAt: number | undefined) {
  if (!expiresAt) return undefined
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 86_400_000))
}

function UsagePanel(props: { context: Plugin.Context; source: UsageSource }) {
  const theme = props.context.theme
  return (
    <box>
      <text fg={theme.text.base}>
        <b>{props.source.title}</b>
      </text>
      <For each={props.source.windows}>
        {(window) => {
          const color = () => windowColor(theme, window)
          const remaining = () => remainingPercent(window)
          const filled = () =>
            Math.max(0, Math.min(BAR_CELLS, Math.floor((remaining() / 100) * BAR_CELLS)))
          return (
            <box>
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <box flexDirection="row" gap={1}>
                  <text fg={color()}>•</text>
                  <text fg={theme.text.base}>{window.label}</text>
                </box>
                <text>
                  <span style={{ fg: color() }}>{"█".repeat(filled())}</span>
                  <span style={{ fg: theme.text.muted }}>{"░".repeat(BAR_CELLS - filled())}</span>
                </text>
              </box>
              <box flexDirection="row" gap={1} justifyContent="space-between" paddingLeft={2}>
                <text fg={theme.text.muted}>{formatRemaining(window.resetsAt)}</text>
                <text fg={theme.text.muted}>{formatRemainingPercent(window)}</text>
              </box>
            </box>
          )
        }}
      </For>
      <Show when={props.source.credits}>
        {(credits) => {
          const days = () => (credits().count > 0 ? expiryDays(credits().expiresAt) : undefined)
          const urgent = () => {
            const value = days()
            return value !== undefined && value <= 5
          }
          return (
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text fg={credits().count > 0 ? theme.text.feedback.success.base : theme.text.muted}>•</text>
                <text fg={theme.text.base}>Resets</text>
              </box>
              <text>
                <span style={{ fg: theme.text.muted }}>
                  {days() === undefined ? String(credits().count) : `${credits().count} · `}
                </span>
                <span style={{ fg: urgent() ? theme.text.feedback.warning.base : theme.text.muted }}>
                  {days() === undefined ? "" : `exp ${days()}d`}
                </span>
              </text>
            </box>
          )
        }}
      </Show>
      <Show when={props.source.error}>
        <text fg={theme.text.muted}>{props.source.error}</text>
      </Show>
    </box>
  )
}

function BalancePanel(props: { context: Plugin.Context; source: BalanceSource }) {
  const theme = props.context.theme
  return (
    <box>
      <text fg={theme.text.base}>
        <b>{props.source.title}</b>
      </text>
      <For each={props.source.rows}>
        {(row) => {
          const color = () =>
            row.level === "empty"
              ? theme.text.feedback.error.base
              : row.level === "low"
                ? theme.text.feedback.warning.base
                : theme.text.feedback.success.base
          return (
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text fg={color()}>•</text>
                <text fg={theme.text.base}>{row.label}</text>
              </box>
              <text fg={row.level === "ok" ? theme.text.muted : color()}>{row.value}</text>
            </box>
          )
        }}
      </For>
      <Show when={props.source.error}>
        <text fg={theme.text.muted}>{props.source.error}</text>
      </Show>
    </box>
  )
}

function SubscriptionUsage(props: { context: Plugin.Context }) {
  const context = props.context
  const [go, setGo] = createSignal<UsageSource>()
  const [gpt, setGpt] = createSignal<UsageSource>()
  const [deepseek, setDeepseek] = createSignal<BalanceSource>()
  const [goAvailable, setGoAvailable] = createSignal(false)
  const [gptAvailable, setGptAvailable] = createSignal(false)
  const [deepseekAvailable, setDeepseekAvailable] = createSignal(false)

  let refreshing = false
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const providerID = context.ui.model.current()?.providerID
      if (providerID === "opencode-go") {
        const key = await goCredential(context)
        setGoAvailable(Boolean(key))
        if (!key) return
        try {
          setGo(await fetchGoUsage(key))
        } catch (error) {
          setGo((previous) => ({
            title: previous?.title ?? "OpenCode Go",
            windows: previous?.windows ?? [],
            error: describe(error),
          }))
        }
        return
      }
      if (providerID === "openai") {
        const credentials = await chatgptCredentials(context)
        setGptAvailable(credentials.length > 0)
        if (credentials.length === 0) return
        let lastError: unknown
        for (const credential of credentials) {
          try {
            setGpt(await fetchChatGPTUsage(credential))
            return
          } catch (error) {
            lastError = error
          }
        }
        setGpt((previous) => ({
          title: previous?.title ?? "ChatGPT",
          windows: previous?.windows ?? [],
          credits: previous?.credits,
          error: describe(lastError),
        }))
      }
      if (providerID === "deepseek") {
        const key = await deepseekCredential(context)
        setDeepseekAvailable(Boolean(key))
        if (!key) return
        try {
          setDeepseek(await fetchDeepSeekBalance(key))
        } catch (error) {
          setDeepseek((previous) => ({
            title: previous?.title ?? "DeepSeek",
            rows: previous?.rows ?? [],
            error: describe(error),
          }))
        }
      }
    } finally {
      refreshing = false
    }
  }

  const providerID = createMemo(() => context.ui.model.current()?.providerID)
  const source = createMemo<UsageSource | undefined>(() => {
    const provider = providerID()
    if (provider === "opencode-go" && goAvailable()) return go() ?? { title: "OpenCode Go", windows: [] }
    if (provider === "openai" && gptAvailable()) return gpt() ?? { title: "ChatGPT", windows: [] }
    return undefined
  })

  const balance = createMemo<BalanceSource | undefined>(() => {
    if (providerID() === "deepseek" && deepseekAvailable()) return deepseek() ?? { title: "DeepSeek", rows: [] }
    return undefined
  })

  let pending: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number) => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => void refresh(), delay)
  }

  createEffect(() => {
    const provider = providerID()
    if (provider === "opencode-go" || provider === "openai" || provider === "deepseek") schedule(150)
  })
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  const stops = [
    context.data.on("session.execution.succeeded", () => schedule(1_500)),
    context.data.on("session.execution.failed", () => schedule(1_500)),
    context.data.on("credential.updated", () => schedule(500)),
    context.data.on("credential.switched", () => schedule(500)),
  ]
  onCleanup(() => {
    clearInterval(timer)
    if (pending) clearTimeout(pending)
    for (const stop of stops) stop()
  })

  return (
    <>
      <Show when={source()}>{(value) => <UsagePanel context={context} source={value()} />}</Show>
      <Show when={balance()}>{(value) => <BalancePanel context={context} source={value()} />}</Show>
    </>
  )
}

export default Plugin.define({
  id: "subscription-usage-sidebar",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <SubscriptionUsage context={context} />,
    })
    return () => unregister()
  },
})
