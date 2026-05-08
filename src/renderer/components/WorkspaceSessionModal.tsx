import { useState } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "./ModalShell"

export interface SessionEntry {
  sessionKey: string
  chatName?: string
}

interface Props {
  open: boolean
  oldPath: string
  newPath: string
  sessions: SessionEntry[]
  onSwitch: (stopOldSessions: boolean) => void
  onCancel: () => void
}

export default function WorkspaceSessionModal({
  open,
  oldPath,
  newPath,
  sessions,
  onSwitch,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const hasSessions = sessions.length > 0

  const handleSwitch = (stopOld: boolean) => {
    setBusy(true)
    onSwitch(stopOld)
  }

  return (
    <ModalShell
      title="切换工作目录"
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <button
            type="button"
            className={`${modalBtnGhost} whitespace-nowrap`}
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          {hasSessions ? (
            <>
              <button
                type="button"
                className={`${modalBtnGhost} whitespace-nowrap`}
                disabled={busy}
                onClick={() => handleSwitch(false)}
              >
                {busy ? "切换中…" : "保留旧会话"}
              </button>
              <button
                type="button"
                className={`${modalBtnPrimary} whitespace-nowrap`}
                disabled={busy}
                onClick={() => handleSwitch(true)}
              >
                {busy ? "切换中…" : "结束旧会话并切换"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${modalBtnPrimary} whitespace-nowrap`}
              disabled={busy}
              onClick={() => handleSwitch(false)}
            >
              {busy ? "切换中…" : "确认切换"}
            </button>
          )}
        </div>
      }
    >
      {hasSessions ? (
        <>
          <p className="mb-3 text-gray-200">
            检测到旧目录下有 <span className="font-semibold text-white">{sessions.length}</span> 个活跃会话：
          </p>
          <ul className="mb-3 max-h-32 overflow-y-auto rounded border border-gray-800 bg-gray-900/50 p-2 text-xs text-gray-400">
            {sessions.map((s) => (
              <li key={s.sessionKey} className="truncate py-0.5 font-mono">
                {s.chatName || s.sessionKey}
              </li>
            ))}
          </ul>
          <p className="mb-3 text-xs text-gray-500">
            选择"保留旧会话"将切换目录但不中断已有 Agent；选择"结束旧会话并切换"将停止它们后再切换。
          </p>
        </>
      ) : (
        <p className="mb-3 text-gray-200">确认将工作目录切换到新路径？</p>
      )}

      <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-900/50 p-2 text-[11px] text-gray-500">
        <div className="min-w-0">
          <div className="mb-0.5 text-gray-600">当前目录</div>
          <div className="break-all font-mono text-gray-400">{oldPath || "（空）"}</div>
        </div>
        <div className="min-w-0">
          <div className="mb-0.5 text-gray-600">目标目录</div>
          <div className="break-all font-mono text-gray-400">{newPath || "（空）"}</div>
        </div>
      </div>
    </ModalShell>
  )
}
