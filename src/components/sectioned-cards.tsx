import * as React from "react"
import { CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * 页内标签页（2026-10-25 管理后台长配置页优化）。
 *
 * 用法：把一串平铺的 <Card> 作为 children 传进来 —— 组件运行时读取每张卡
 * 的 CardTitle 文本作为子标签名，顶栏横向排开，只渲染当前选中那张卡。
 * 长配置页从「无限下滚」变成「点标签直达」。
 *
 * 为什么在运行时提取标题而不是手工分组：管理后台几十个页面的卡片结构
 * 各不相同且会持续增删，手工维护「卡 → 分组」映射必然漂移；而 JSX 在
 * 渲染函数执行时求值，{t("adm.xxx")} 传给 CardTitle 的已经是最终字符串，
 * 运行时提取是零维护的。
 *
 * 兜底（不需要拆页的场景一律自动退回原样渲染）：
 *   - children 里有效卡片数 ≤ 2（拆了反而多点一步）；
 *   - 任何一张卡提取不到标题（非 Card 结构 / 结构特殊）。
 * 这样调用方可以放心包：结构不合适时表现与原来完全一致。
 */
export function SectionedCards({
  pageKey,
  children,
}: {
  /** 子标签选中状态的持久化键（同一页面刷新后停留在原标签） */
  pageKey: string
  children: React.ReactNode
}) {
  const cards = React.Children.toArray(children).filter((c): c is React.ReactElement =>
    React.isValidElement(c)
  )

  const kidsOf = (node: React.ReactElement): React.ReactNode | undefined =>
    (node.props as { children?: React.ReactNode }).children

  /** 从卡片元素里递归找 CardTitle 的文本 */
  const titleOf = (node: React.ReactNode): string | null => {
    if (!React.isValidElement(node)) return null
    if (node.type === CardTitle) {
      return textOf(kidsOf(node))
    }
    const kids = kidsOf(node)
    if (kids === undefined) return null
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const hit = titleOf(k)
        if (hit) return hit
      }
      return null
    }
    return titleOf(kids)
  }

  const textOf = (node: React.ReactNode): string | null => {
    if (typeof node === "string") return node.trim() || null
    if (typeof node === "number") return String(node)
    if (Array.isArray(node)) {
      for (const k of node) {
        const hit = textOf(k)
        if (hit) return hit
      }
      return null
    }
    if (React.isValidElement(node)) return textOf(kidsOf(node))
    return null
  }

  // 提取不到标题的卡（结构特殊 / 无 CardTitle）统一收进「其他」标签，
  // 而不是让一张怪卡把整页的分组能力拖垮。
  const OTHER = "其他"
  const titled = cards.map((card) => ({ card, title: titleOf(card) ?? OTHER }))
  const namedCount = cards.length - titled.filter((x) => x.title === OTHER).length

  // 兜底：可命名的卡片太少（≤2）→ 拆了反而多点一步，原样平铺
  if (titled.length <= 2 || namedCount <= 1) {
    return <div className="space-y-6">{children}</div>
  }

  const storageKey = `admin-section-tab:${pageKey}`
  const validTitles: string[] = titled.map((x) => x.title).filter((t): t is string => !!t)

  const [active, setActive] = React.useState<string>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      return saved && validTitles.includes(saved) ? saved : (validTitles[0] as string)
    } catch {
      return (validTitles[0] as string) ?? ""
    }
  })

  const select = (title: string) => {
    setActive(title)
    try {
      localStorage.setItem(storageKey, title)
    } catch {
      /* 隐私模式下存不进去：本次会话内切换仍生效 */
    }
  }

  return (
    <div>
      {/* 子标签栏：横向滚动容纳任意多标签；与侧边栏分组折叠同一套黑白灰风格 */}
      <div className="mb-4 -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {titled.map(({ title }) => (
          <button
            key={title as string}
            type="button"
            onClick={() => select(title as string)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors",
              active === title
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            {title}
          </button>
        ))}
      </div>
      {/* 只渲染选中的那张卡 */}
      {titled.find((x) => x.title === active)?.card ?? null}
    </div>
  )
}
