import { useState, useRef, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Search } from "lucide-react"

interface Option {
  id: string
  label: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
}

const DROP_MAX_H = 280

export default function SearchableSelect({ value, onChange, options, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [style, setStyle] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reposition = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - 8
    const spaceAbove = r.top - 8
    const flipUp = spaceBelow < DROP_MAX_H && spaceAbove > spaceBelow

    if (flipUp) {
      setStyle({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceAbove, DROP_MAX_H) })
    } else {
      setStyle({ top: r.bottom + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceBelow, DROP_MAX_H) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    if (inputRef.current) inputRef.current.focus({ preventScroll: true })
    const onLayout = () => reposition()
    window.addEventListener("scroll", onLayout, true)
    window.addEventListener("resize", onLayout)
    return () => {
      window.removeEventListener("scroll", onLayout, true)
      window.removeEventListener("resize", onLayout)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  const selected = options.find((o) => o.id === value)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { setOpen(!open); setQuery("") }}
        className="flex h-[34px] w-full items-center justify-between rounded-md border border-gray-700 bg-gray-800 px-3 text-left text-sm outline-none transition hover:border-gray-600 focus:border-blue-500"
      >
        <span className={selected ? "text-gray-100" : "text-gray-500"}>
          {selected?.label || placeholder || "选择..."}
        </span>
        <ChevronDown size={14} className={`text-gray-500 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[9999] flex flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
          style={style}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-3 py-2">
            <Search size={14} className="text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-600"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-500">无匹配结果</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-gray-800 ${
                    o.id === value ? "bg-blue-600/20 text-blue-400" : "text-gray-300"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
