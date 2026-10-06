import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"

function familyIDs(context: Plugin.Context, sessionID: string) {
  const ids = context.data.session.family(sessionID)
  return ids.length > 0 ? ids : [sessionID]
}

function GitPanel(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const location = () => props.context.location ?? props.context.data.location.default()
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

  createEffect(() => {
    if (vcs()) void refresh()
  })
  const poll = setInterval(() => {
    if (vcs()) void refresh()
  }, 5_000)
  const stopListen = props.context.data.on("session.step.ended", (event) => {
    if (familyIDs(props.context, props.sessionID).includes(event.data.sessionID)) void refresh()
  })
  onCleanup(() => {
    clearInterval(poll)
    stopListen()
  })

  return (
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
