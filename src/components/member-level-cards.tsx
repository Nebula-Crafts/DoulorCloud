import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

/**
 * 会员等级「银行卡」轮播（2026-11-06 站长要求）。
 *
 * 视觉参照 credit.linux.do 的会员等级卡：2:1 圆角卡片 + 分级渐变 + 顶部高光 +
 * 噪点 + 内描边，正文四段布局（英文等级名 / 中文等级名 → 所需积分 → 品牌行 +
 * 当前积分）。四个等级各一套配色，同一张卡在任意屏宽下都能读清。
 *
 * 轮播形态（站长原话「居中展示完整的一张银行卡，左右两边只显示一半，可用鼠标
 * 拖动滑动」）：
 *   * 用「逻辑环」而不是 DOM 克隆 —— 每张卡按与当前浮点位置的**环形最短距离**
 *     定位，因此永远有「中间整张 + 左右各半张」，拖到第一张左边也能看到最后一张，
 *     不会出现首尾两侧留白；
 *   * 拖动时位置是浮点数（跟手），松手四舍五入吸附到最近一张；
 *   * 触摸/鼠标统一用 Pointer Events，另配左右箭头与圆点，键盘 ←/→ 也能切。
 *
 * 为什么不用现有轮播库：项目里没有 carousel 依赖，而这里需要的只是「绝对定位 +
 * 环形距离」这一层逻辑（不到 60 行），引一个包反而要为它维护一套 CSS 变量与主题
 * 适配。
 */

/** 每个等级的卡面配色（顺序与 users.member_level 一致：0 普通 → 3 黑金） */
const TONES = [
  {
    /** 深蓝：会员默认色，白字 */
    card: "bg-gradient-to-br from-[#1e3a8a] via-[#2563eb] to-[#1d4ed8] shadow-blue-900/20",
    text: "text-white/95",
    badge: "bg-white/20 text-white",
    dot: "bg-blue-600",
  },
  {
    /** 金：浅金底 + 深棕字，避免金字白字在浅金上糊掉 */
    card: "bg-gradient-to-br from-[#FDFCF0] via-[#FCE38A] to-[#B45309] shadow-amber-500/20",
    text: "text-[#854D0E]",
    badge: "bg-[#B45309]/15 text-[#7C2D12]",
    dot: "bg-amber-500",
  },
  {
    /** 银白：冷灰渐变 + 深灰字 */
    card: "bg-gradient-to-br from-[#F8FAFC] via-[#E2E8F0] to-[#94A3B8] shadow-slate-500/20",
    text: "text-slate-800",
    badge: "bg-slate-900/10 text-slate-800",
    dot: "bg-slate-400",
  },
  {
    /** 黑金：近黑渐变 + 香槟金字 */
    card: "bg-gradient-to-br from-[#020617] via-[#1e293b] to-[#020617] shadow-black/30",
    text: "text-[#FFE5B4]",
    badge: "bg-[#FFE5B4]/15 text-[#FFE5B4]",
    dot: "bg-slate-800",
  },
] as const

/** 卡面噪点：内联 SVG 湍流，避免依赖外链（离线 / CSP 下也能显示） */
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")"

const GAP = 16

/** 卡号展示：4 位一段（与 worker 端 card-numbers.formatCardNo 同构，前端只需要展示） */
const formatCardNo = (no: string) => no.replace(/(\d{4})(?=\d)/g, "$1 ")

export interface MemberLevelCard {
  /** 中文等级名（i18n key，如 lvl.2） */
  nameKey: string
  /** 英文等级名（i18n key） */
  enKey: string
  /**
   * 该等级「升级所需」积分：
   *   0 级恒为 0（注册即得），1–3 级由后台配置，0 表示未开放
   */
  price: number
  /** 是否已达成（含当前等级） */
  reached: boolean
  /** 是否为当前等级 */
  current: boolean
}

export function MemberLevelCards({
  cards,
  balance,
  cardNo,
  className,
}: {
  cards: MemberLevelCard[]
  /** 用户当前积分余额（卡面右下的「当前积分」） */
  balance: number
  /**
   * 会员银行卡号（16 位数字，黄金及以上才有）。
   * 显示在**当前等级那张卡**的中间，替换掉「升级所需」—— 号随等级走，号本身不变。
   */
  cardNo?: string | null
  className?: string
}) {
  const { t } = useT()
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(0)
  /** 浮点位置：整数即吸附到某张卡，拖动过程中是小数 */
  const [pos, setPos] = React.useState(() => {
    const idx = cards.findIndex((c) => c.current)
    return idx < 0 ? 0 : idx
  })
  const drag = React.useRef<{ startX: number; startPos: number; moved: boolean } | null>(null)

  const n = cards.length
  /** 卡片宽度：窄屏几乎占满（两侧露一点点），宽屏约半屏（两侧各露半张） */
  const slideW = width > 0 ? (width < 640 ? Math.min(width * 0.82, 360) : Math.min(width * 0.52, 460)) : 320
  const step = slideW + GAP

  React.useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // 等级数据变了（升级成功、后台改价）后重新对准当前等级
  const currentIdx = cards.findIndex((c) => c.current)
  React.useEffect(() => {
    if (currentIdx >= 0) setPos(currentIdx)
  }, [currentIdx])

  const norm = (i: number) => ((i % n) + n) % n

  /** 吸附到最近的整数位（环形） */
  const snap = (p: number) => {
    const target = Math.round(p)
    setPos(target)
    return target
  }

  const goTo = (i: number) => {
    // 选最近的环形路径，避免从 0 到 3 长距离滑过 1、2
    const from = Math.round(pos)
    const forward = norm(i - from)
    const backward = forward - n
    const delta = Math.abs(forward) <= Math.abs(backward) ? forward : backward
    setPos(from + delta)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    drag.current = { startX: e.clientX, startPos: pos, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) > 3) d.moved = true
    if (d.moved) setPos(d.startPos - dx / step)
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d) snap(pos)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      setPos(Math.round(pos) - 1)
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      setPos(Math.round(pos) + 1)
    }
  }

  if (n === 0) return null
  const activeIdx = norm(Math.round(pos))
  const height = slideW / 2

  return (
    <div className={cn("relative", className)}>
      {/* 拖拽区：两侧渐隐遮罩只做视觉，不拦事件 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-card to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-card to-transparent" />

      <div
        ref={boxRef}
        role="region"
        aria-roledescription="carousel"
        aria-label={t("pt.level.title")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative touch-pan-y select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        style={{ height: width > 0 ? height : slideW / 2 }}
      >
        {cards.map((c, i) => {
          // 环形最短距离：让第 0 张的左边是最后一张，两侧永远有卡
          const raw = i - pos
          const wrapped = ((raw % n) + n) % n
          const delta = wrapped > n / 2 ? wrapped - n : wrapped
          const abs = Math.abs(delta)
          const tone = TONES[i % TONES.length]
          const active = abs < 0.5
          return (
            <div
              key={c.nameKey}
              className="absolute top-0 transition-opacity duration-300"
              style={{
                left: width > 0 ? width / 2 - slideW / 2 + delta * step : 0,
                width: slideW,
                height,
                opacity: abs > 1.5 ? 0 : active ? 1 : 0.7,
                pointerEvents: active ? "auto" : "none",
                zIndex: active ? 2 : 1,
              }}
              aria-hidden={!active}
            >
              <div
                className={cn(
                  "relative h-full w-full overflow-hidden rounded-xl transition-transform duration-300",
                  tone.card
                )}
                style={{ transform: `scale(${active ? 1 : 0.92})` }}
              >
                {/* 两团白色虚化光斑 + 噪点 + 内描边 + 顶部高光：卡面质感层 */}
                <div className="absolute inset-0 opacity-10">
                  <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white blur-3xl" />
                  <div className="absolute -bottom-10 -left-10 h-32 w-32 rounded-full bg-white blur-3xl" />
                </div>
                <div
                  className="absolute inset-0 opacity-[0.13] mix-blend-overlay"
                  style={{ backgroundImage: NOISE }}
                />
                <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-white/10 via-transparent to-transparent" />
                <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/25" />
                <div className="absolute inset-x-0 top-0 h-1/4 rounded-t-xl bg-gradient-to-b from-white/15 via-transparent to-transparent" />

                <div
                  className={cn(
                    "relative flex h-full flex-col justify-between p-3 sm:p-4",
                    tone.text
                  )}
                >
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.12em] opacity-70">
                      {t(c.enKey)}
                    </div>
                    <div className="text-base font-bold tracking-tight sm:text-lg">
                      {t(c.nameKey)}
                    </div>
                  </div>

                  {/* 中间区块：黄金及以上的**当前**卡显示卡号，其余卡显示升级所需积分。
                      卡号随等级换到新卡上，号本身不变（存 users.card_no）。 */}
                  {c.current && cardNo ? (
                    <div>
                      <div className="text-[11px] opacity-70">{t("pt.card.no")}</div>
                      <div className="font-mono text-lg font-bold tracking-[0.14em] tabular-nums sm:text-xl">
                        {formatCardNo(cardNo)}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-[11px] opacity-70">{t("pt.card.need")}</div>
                      <div className="text-2xl font-bold tabular-nums sm:text-3xl">
                        {c.price > 0
                          ? c.price.toLocaleString()
                          : c.current || c.reached
                            ? t("pt.card.granted")
                            : t("pt.card.closed")}
                      </div>
                    </div>
                  )}

                  <div className="flex items-end justify-between gap-2">
                    <div className="text-[11px] opacity-70">
                      {t("pt.card.brand")}{" "}
                      <span className="font-serif italic">{t("pt.card.brandEm")}</span>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] opacity-70">{t("pt.card.balance")}</div>
                      <div className="text-sm font-semibold tabular-nums">
                        {balance.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 右上角状态徽章 */}
                <div className="absolute right-3 top-3 sm:right-4 sm:top-4">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur-sm",
                      tone.badge
                    )}
                  >
                    {c.current
                      ? t("pt.level.current")
                      : c.reached
                        ? t("pt.card.reached")
                        : t("pt.card.locked")}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 左右两侧的滑动按钮：压在卡片边缘、垂直居中（站长 2026-11-06 要求）。
          拖拽是隐式交互，光靠它不好发现 —— 这两颗按钮是明确的滑动入口，
          与拖拽、下方圆点、键盘 ←/→ 等价。 */}
      <button
        type="button"
        aria-label={t("pt.card.prev")}
        onClick={() => setPos(Math.round(pos) - 1)}
        className="absolute left-0 z-30 -translate-y-1/2 rounded-full border bg-background/90 p-2 text-foreground/80 shadow-md backdrop-blur transition hover:scale-105 hover:text-foreground active:scale-95"
        style={{ top: height / 2 }}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label={t("pt.card.next")}
        onClick={() => setPos(Math.round(pos) + 1)}
        className="absolute right-0 z-30 -translate-y-1/2 rounded-full border bg-background/90 p-2 text-foreground/80 shadow-md backdrop-blur transition hover:scale-105 hover:text-foreground active:scale-95"
        style={{ top: height / 2 }}
      >
        <ChevronRight className="h-5 w-5" />
      </button>

      {/* 圆点指示器：当前等级用该等级卡面的主色 */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {cards.map((c, i) => (
          <button
            key={c.nameKey}
            type="button"
            aria-label={t(c.nameKey)}
            aria-current={i === activeIdx}
            onClick={() => goTo(i)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i === activeIdx
                ? cn("w-5", TONES[i % TONES.length].dot)
                : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60"
            )}
          />
        ))}
      </div>
    </div>
  )
}