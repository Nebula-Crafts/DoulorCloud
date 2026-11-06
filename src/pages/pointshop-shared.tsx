/**
 * 积分页与商城页共享的常量、工具与组件（2026-11-06 拆分）。
 *
 * 拆分前它们都挤在 points.tsx 里；两页各自要用其中一部分
 * （积分页：明细弹窗的文案映射；商城页：商品卡 / 售后 / 上架表单），
 * 抽到这里让两页互不牵扯，改商品卡不用先读完 2700 行页面。
 */
import * as React from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useT, tStatic } from "@/i18n"
import { fmtDateTime } from "@/lib/format"
import type { AfterSaleStatus, PointOrder } from "@/types"

/** 流水来源 → 展示标签 */
const REASON_LABEL: Record<string, string> = {
  event: "pt.reason.event",
  admin: "pt.reason.admin",
  redeem: "pt.reason.redeem",
  shop: "pt.reason.shop",
  shop_sell: "pt.reason.shopSell",
  donation: "pt.reason.donation",
  invite: "pt.reason.invite",
  invite_commission: "pt.reason.inviteCommission",
  transfer_out: "pt.reason.transferOut",
  transfer_in: "pt.reason.transferIn",
  app: "pt.reason.app",
  star_in: "pt.reason.star_in",
  star_out: "pt.reason.star_out",
}

/** 订单状态 → 展示标签（用户商品订单的 pending/delivered 含义不同，用 orderStatusText 区分） */
const ORDER_STATUS: Record<string, { label: string; variant: "default" | "outline" | "secondary" }> = {
  pending: { label: "pt.status.pending", variant: "default" },
  delivered: { label: "pt.status.delivered", variant: "outline" },
  settled: { label: "pt.status.settled", variant: "outline" },
  cancelled: { label: "pt.status.cancelled", variant: "secondary" },
}

/**
 * 订单状态的展示文案。
 *
 * 用户商品走**担保**：pending = 等卖家交付（积分在平台手里）、
 * delivered = 卖家已交付、等你确认收货。跟官方商品的「待发放 / 已发放」不是一回事。
 *
 * ⚠️ 返回的是 **i18n key**，调用方要再套一层 t()（这样语言切换能立刻生效）。
 */
function orderStatusText(status: string, isUserOrder: boolean): string {
  if (isUserOrder) {
    if (status === "pending") return "pt.status.awaitSeller"
    if (status === "delivered") return "pt.status.awaitReceipt"
    if (status === "settled") return "pt.status.done"
  }
  return ORDER_STATUS[status]?.label ?? status
}

/** 售后状态 → 展示标签（只在订单确实走过售后时才显示） */
const AFTER_SALE_STATUS: Record<
  AfterSaleStatus,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  requested: { label: "pt.afterSale.st.requested", variant: "default" },
  rejected: { label: "pt.afterSale.st.rejected", variant: "destructive" },
  platform: { label: "pt.afterSale.st.platform", variant: "default" },
  closed: { label: "pt.afterSale.st.closed", variant: "secondary" },
  refunded: { label: "pt.afterSale.st.refunded", variant: "success" },
}

/**
 * 买家能不能对这笔订单申请退款。
 *
 * 与后端 `requestAfterSale` 的口径保持一致：
 *   · 订单必须是 delivered（卖家已交付、我还没确认）或 settled（已确认收货）；
 *   · 没有进行中的售后（requested / platform）—— 已退款更不行；
 *   · 卖家拒绝 / 平台驳回之后允许重新申请。
 * 「确认收货后 7 天」的期限由后端判定（前端不重复实现，避免两边算出不同结果）。
 */
function canRequestAfterSale(o: PointOrder): boolean {
  if (o.status !== "delivered" && o.status !== "settled") return false
  const s = o.afterSaleStatus
  return s === null || s === "rejected" || s === "closed"
}

/** 买家能不能申请平台介入（卖家一直不处理 / 已拒绝） */
function canEscalateAfterSale(o: PointOrder): boolean {
  return o.afterSaleStatus === "requested" || o.afterSaleStatus === "rejected"
}

/**
 * 买家能不能「拒收」（2026-10-06 站长要求）。
 *
 * 卖家点了「已交付」但买家实际没收到 / 货不对板时，一键直达平台介入，
 * 不用先向卖家申请退款（卖家自己声称交付了，让他审自己的退款没意义）。
 * 只对**用户商品**订单（有卖家）生效；官方商品走「申请售后」。
 */
function canRejectDelivery(o: PointOrder): boolean {
  if (o.sellerId === null) return false
  if (o.status !== "delivered") return false
  const s = o.afterSaleStatus
  return s === null || s === "rejected" || s === "closed"
}

/** 买家能不能自己撤销（已经申请平台介入后要等客服判定，不能自撤） */
function canWithdrawAfterSale(o: PointOrder): boolean {
  return o.afterSaleStatus === "requested"
}

/** 售后对话框三种模式各自的文案 key（申请退款 / 卖家拒绝 / 买家拒收） */
const AFTER_SALE_DIALOG: Record<
  "request" | "reject" | "rejectDelivery",
  { title: string; desc: string; label: string; placeholder: string }
> = {
  request: {
    title: "pt.afterSale.request",
    desc: "pt.afterSale.requestDesc",
    label: "pt.afterSale.reasonLabel",
    placeholder: "pt.afterSale.reasonPlaceholder",
  },
  reject: {
    title: "pt.afterSale.reject",
    desc: "pt.afterSale.rejectDesc",
    label: "pt.afterSale.rejectNote",
    placeholder: "pt.afterSale.rejectPlaceholder",
  },
  rejectDelivery: {
    title: "pt.afterSale.rejectDelivery",
    desc: "pt.afterSale.rejectDeliveryDesc",
    label: "pt.afterSale.reasonLabel",
    placeholder: "pt.afterSale.rejectDeliveryPlaceholder",
  },
}

/**
 * 交付方式 → 商品卡上的一句说明。
 *
 * 用户视角只需要知道「下单后会发生什么、要不要等」，不需要知道内部类型名。
 */
function deliveryLabel(delivery: string): string {
  switch (delivery) {
    case "quota":
      return tStatic("pt.delivery.quota")
    case "feature":
      return tStatic("pt.delivery.feature")
    case "subscription":
      return tStatic("pt.delivery.subscription")
    case "invite_quota":
      return tStatic("pt.delivery.inviteQuota")
    case "code":
      return tStatic("pt.delivery.code")
    case "content":
      return tStatic("pt.delivery.content")
    default:
      return tStatic("pt.delivery.manual")
  }
}

/** 需要先绑定中转站账号才能自动发放的方式（余额 / 订阅都挂在 NewAPI 用户上） */
function needsNewapiBinding(delivery: string): boolean {
  return delivery === "quota" || delivery === "subscription"
}

/** 购买弹窗顶部的一句说明：下单后到底会发生什么 */
function buyHint(delivery: string, isUserProduct: boolean): string {
  if (isUserProduct) {
    // 用户商品是担保交易：钱先放平台，卖家交付 + 买家确认后才转给卖家
    return tStatic("pt.buyHint.userProduct")
  }
  switch (delivery) {
    case "quota":
      return tStatic("pt.buyHint.quota")
    case "feature":
      return tStatic("pt.buyHint.feature")
    case "subscription":
      return tStatic("pt.buyHint.subscription")
    case "invite_quota":
      return tStatic("pt.buyHint.inviteQuota")
    case "code":
      return tStatic("pt.buyHint.code")
    case "content":
      return tStatic("pt.buyHint.content")
    default:
      return tStatic("pt.buyHint.manual")
  }
}

/** 租期展示：如「租用 30 天」 */
function rentalTerm(days: number | null | undefined): string {
  return days && days > 0 ? tStatic("pt.rental.term", { n: days }) : tStatic("pt.rental.rental")
}

/**
 * 自动发货的正文块（统一内容 / 卡密）。
 *
 * 为什么单独一块而不是跟摘要挤在一行：这是买家**买到的东西**本身
 * （网盘链接 + 提取码、卡密、使用说明），必须
 *   · 能看清换行（`whitespace-pre-wrap`），不能像普通摘要那样截断；
 *   · 能一键复制（用户下一个动作就是粘贴到网盘/客户端）；
 *   · 用等宽字体，避免链接里的 `l/1/O/0` 看错。
 */
function DeliveryContentBlock({ content }: { content: string }) {
  const { t } = useT()
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t("pt.copyFailed"))
    }
  }
  return (
    <div className="mt-1 w-full space-y-1 rounded-md border bg-muted/30 p-2 text-left">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("pt.deliveryContent")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          onClick={() => void copy()}
          title={t("pt.copyContent")}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <p className="whitespace-pre-wrap break-all font-mono text-xs">{content}</p>
    </div>
  )
}

/** 租用订单是否已到期（只有租用订单才有 expiresAt） */
function isRentalExpired(o: PointOrder): boolean {
  if (!o.expiresAt) return false
  const t = new Date(o.expiresAt).getTime()
  return !Number.isNaN(t) && t <= Date.now()
}

/**
 * 订单上的租期说明。
 *
 * · 还没交付 → 只说明租期，提示「交付后起算」（租期不是从下单起算的）
 * · 已交付未到期 → 有效期至 X
 * · 已到期 → 已到期（X）
 * · 已取消 / 买断单 → 没有租期可讲，返回 null
 */
function rentalOrderText(o: PointOrder): string | null {
  if (o.billingMode !== "rental") return null
  if (o.status === "cancelled") return null
  if (!o.expiresAt) return tStatic("pt.rental.afterDelivery", { term: rentalTerm(o.rentalDays) })
  const time = fmtDateTime(o.expiresAt)
  return isRentalExpired(o)
    ? tStatic("pt.rental.expired", { time })
    : tStatic("pt.rental.validUntil", { time })
}

/** 购买弹窗里对「租用」的一句解释（官方自动发放 vs 用户商品，收尾方式不同） */
function rentalBuyHint(days: number | null, isUserProduct: boolean): string {
  const term = days && days > 0 ? tStatic("pt.days", { n: days }) : tStatic("pt.rental.oneTerm")
  if (isUserProduct) {
    return tStatic("pt.rental.buyHintUser", { term })
  }
  return tStatic("pt.rental.buyHintOfficial", { term })
}

/** 金额展示：整数不带小数，非整数保留两位 */
function fmtMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export {
  REASON_LABEL,
  ORDER_STATUS,
  orderStatusText,
  AFTER_SALE_STATUS,
  canRequestAfterSale,
  canEscalateAfterSale,
  canRejectDelivery,
  canWithdrawAfterSale,
  AFTER_SALE_DIALOG,
  deliveryLabel,
  needsNewapiBinding,
  buyHint,
  rentalTerm,
  DeliveryContentBlock,
  isRentalExpired,
  rentalOrderText,
  rentalBuyHint,
  fmtMoney,
}
