import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

function familyIDs(context: Plugin.Context, sessionID: string) {
  const ids = context.data.session.family(sessionID)
  return ids.length > 0 ? ids : [sessionID]
}

type RepoState = {
  branch?: string
  files: number
  additions: number
  deletions: number
  error?: true
}

const SCAN_SKIP = new Set(["node_modules"])
const SCAN_DEPTH = 4
const SCAN_LIMIT = 8
const REPO_LIMIT = 4

// Nested repos are queried through the git CLI instead of the server VCS API:
// resolving a subdirectory as a location would persist it as a project.
function runGit(directory: string, args: readonly string[]) {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      "git",
      ["-C", directory, ...args],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    )
  })
}

async function discoverRepos(root: string) {
  const found: string[] = []
  const queue = [{ directory: root, depth: 0 }]
  for (let index = 0; index < queue.length && found.length < SCAN_LIMIT; index++) {
    const current = queue[index]
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.name === ".git")) {
      found.push(current.directory)
      continue
    }
    if (current.depth >= SCAN_DEPTH) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || SCAN_SKIP.has(entry.name)) continue
      queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 })
    }
  }
  return found
}

async function readRepoState(directory: string): Promise<RepoState> {
  const status = await runGit(directory, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    "--no-renames",
    "-z",
  ])
  if (status === undefined) return { files: 0, additions: 0, deletions: 0, error: true }
  let branch: string | undefined
  let files = 0
  for (const record of status.split("\0")) {
    if (!record) continue
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length)
      branch = value === "(detached)" ? "detached" : value === "(initial)" ? "initial" : value
      continue
    }
    if (record.startsWith("#")) continue
    files++
  }
  let additions = 0
  let deletions = 0
  if (branch !== "initial") {
    const stats = await runGit(directory, ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", "HEAD", "--", "."])
    for (const item of (stats ?? "").split("\0")) {
      if (!item) continue
      const first = item.indexOf("\t")
      const second = item.indexOf("\t", first + 1)
      if (first === -1 || second === -1) continue
      const adds = item.slice(0, first)
      const dels = item.slice(first + 1, second)
      if (adds !== "-") additions += Number.parseInt(adds || "0", 10) || 0
      if (dels !== "-") deletions += Number.parseInt(dels || "0", 10) || 0
    }
  }
  return { branch, files, additions, deletions }
}

function GitPanel(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  // Prefer the rendered session's own location so tabs across directories show
  // the right repository; fall back to the TUI's current/default location.
  const location = () =>
    props.context.data.session.get(props.sessionID)?.location ??
    props.context.location ??
    props.context.data.location.default()
  const vcs = createMemo(() => props.context.data.location.vcs.info(location()))
  const [stats, setStats] = createSignal<{ files: number; additions: number; deletions: number }>()
  const refresh = () =>
    props.context.client.vcs
      .status({ location: location() })
      .then((result) => {
        const files = result.data ?? []
        setStats({
          files: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        })
      })
      .catch(() => setStats(undefined))

  const [repos, setRepos] = createSignal<Array<{ name: string; directory: string }>>([])
  const [repoStates, setRepoStates] = createSignal<Record<string, RepoState>>({})

  let disposed = false
  let scanning = false
  let refreshingRepos = false
  const scan = async () => {
    if (scanning) return
    scanning = true
    try {
      const root = location().directory
      if (!root) return
      const found = (await discoverRepos(root)).map((directory) => ({
        directory,
        name: relative(root, directory).replaceAll("\\", "/"),
      }))
      if (!disposed) setRepos(found)
    } finally {
      scanning = false
    }
  }
  const refreshRepos = async () => {
    if (refreshingRepos) return
    refreshingRepos = true
    try {
      const list = repos()
      if (list.length === 0) return
      const entries = await Promise.all(
        list.map(async (repo) => [repo.directory, await readRepoState(repo.directory)] as const),
      )
      if (!disposed) setRepoStates(Object.fromEntries(entries))
    } finally {
      refreshingRepos = false
    }
  }

  // A markerless location still answers vcs.get with an empty { branch: {} }
  // object, so repository detection keys on branch.current, not on info itself.
  const inRepo = () => Boolean(vcs()?.branch.current)
  createEffect(() => {
    if (inRepo()) {
      void refresh()
      return
    }
    void scan().then(() => refreshRepos())
  })
  const poll = setInterval(() => {
    if (inRepo()) void refresh()
    else void refreshRepos()
  }, 5_000)
  // Structural rescans are slow-cadenced; status polls stay on the fast timer.
  const rescan = setInterval(() => {
    if (!inRepo()) void scan().then(() => refreshRepos())
  }, 60_000)
  const stopListen = props.context.data.on("session.step.ended", (event) => {
    if (!familyIDs(props.context, props.sessionID).includes(event.data.sessionID)) return
    if (inRepo()) void refresh()
    else void refreshRepos()
  })
  onCleanup(() => {
    disposed = true
    clearInterval(poll)
    clearInterval(rescan)
    stopListen()
  })

  return (
    <>
      <Show when={vcs()?.branch.current}>
        {(branch) => (
          <box>
            <text fg={theme.text.base}>
              <b>Git</b>
            </text>
            <box flexDirection="row" gap={1} minWidth={0}>
              <text flexShrink={0} fg={theme.text.feedback.success.base}>
                •
              </text>
              <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                {branch()}
              </text>
            </box>
            <Show when={vcs()?.branch.default && vcs()?.branch.default !== branch()}>
              <text fg={theme.text.muted} wrapMode="none" truncate>
                default: {vcs()?.branch.default}
              </text>
            </Show>
            <Show when={stats()}>
              {(value) => (
                <box flexDirection="row" gap={1}>
                  <Show when={value().files > 0} fallback={<text fg={theme.text.muted}>clean</text>}>
                    <text fg={theme.text.muted}>{value().files} files</text>
                    <text fg={theme.text.feedback.success.base}>+{value().additions}</text>
                    <text fg={theme.text.feedback.error.base}>−{value().deletions}</text>
                  </Show>
                </box>
              )}
            </Show>
          </box>
        )}
      </Show>
      <Show when={!inRepo() && repos().length > 0}>
        <box>
          <text fg={theme.text.base}>
            <b>Git</b>
          </text>
          <For each={repos().slice(0, REPO_LIMIT)}>
            {(repo) => {
              const state = () => repoStates()[repo.directory]
              return (
                <box>
                  <box flexDirection="row" gap={1} justifyContent="space-between" minWidth={0}>
                    <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                      <text flexShrink={0} fg={theme.text.feedback.success.base}>
                        •
                      </text>
                      <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                        {repo.name}
                      </text>
                    </box>
                    <text flexShrink={0} fg={theme.text.muted}>
                      {state()?.branch ?? ""}
                    </text>
                  </box>
                  <Show when={state()}>
                    {(value) => (
                      <box flexDirection="row" gap={1} paddingLeft={2}>
                        <Show when={!value().error} fallback={<text fg={theme.text.muted}>unavailable</text>}>
                          <Show when={value().files > 0} fallback={<text fg={theme.text.muted}>clean</text>}>
                            <text fg={theme.text.muted}>{value().files} files</text>
                            <text fg={theme.text.feedback.success.base}>+{value().additions}</text>
                            <text fg={theme.text.feedback.error.base}>−{value().deletions}</text>
                          </Show>
                        </Show>
                      </box>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={repos().length > REPO_LIMIT}>
            <text fg={theme.text.muted}>+{repos().length - REPO_LIMIT} more</text>
          </Show>
        </box>
      </Show>
    </>
  )
}

export default Plugin.define({
  id: "git-status-sidebar",
  setup(context) {
    void context.data.location.vcs.sync(context.location)
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <GitPanel context={context} sessionID={input.sessionID} />,
    })
    return () => unregister()
  },
})
