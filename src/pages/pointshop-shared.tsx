/**
 * 积分页与商城页共享的常量、工具与组件（2026-11-06 拆分）。
 *
 * 拆分前它们都挤在 points.tsx 里；两页各自要用其中一部分
 * （积分页：明细弹窗的文案映射；商城页：商品卡 / 售后 / 上架表单），
 * 抽到这里让两页互不牵扯，改商品卡不用先读完 2700 行页面。
 */
import * as React from "react"
import { Link } from "react-router-dom"
import { CalendarClock, Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { pointsApi, errMsg } from "@/services/api"
import { useT, tStatic } from "@/i18n"
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from "@/types"
import { fmtDateTime } from "@/lib/format"
import { shopIcon } from "@/lib/shop-icons"
import type {
  AfterSaleStatus,
  PointBillingMode,
  PointDelivery,
  PointOrder,
  PointProduct,
  UserProductPayload,
} from "@/types"

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

/** 自己上架商品的审核状态 → 标签 */
const MY_REVIEW: Record<
  string,
  { label: string; variant: "default" | "outline" | "secondary" | "destructive" | "success" }
> = {
  pending: { label: "pt.review.pending", variant: "default" },
  approved: { label: "pt.review.approved", variant: "success" },
  rejected: { label: "pt.review.rejected", variant: "destructive" },
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

/**
 * 商品卡片顶部的封面区（固定 144px 高，保证同一行卡片对齐）。
 *
 * 三种来源，优先级：**真实图片 > 用户/站长选的图标 > 默认图标**。
 * 图标单独占满整个封面区（80px 见方），是卡片上最显眼的一块。
 */
function ProductCover({
  imageUrl,
  icon,
  name,
}: {
  imageUrl?: string | null
  icon?: string | null
  name: string
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        className="h-36 w-full shrink-0 rounded-t-xl object-cover"
      />
    )
  }
  const Icon = shopIcon(icon)
  return (
    <div className="flex h-36 w-full shrink-0 items-center justify-center overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-primary/15 via-primary/5 to-transparent">
      <Icon className="h-20 w-20 text-primary" strokeWidth={1.25} aria-hidden />
    </div>
  )
}

/** 商城分类筛选项（「全部」+ 各分类） */
const SHOP_CAT_FILTERS: { key: ProductCategory | "all"; label: string }[] = [
  { key: "all", label: "pt.cat.all" },
  { key: "it", label: PRODUCT_CATEGORY_LABELS.it },
  { key: "other", label: PRODUCT_CATEGORY_LABELS.other },
]

/** 商品卡片（官方 / 用户商品共用；卖家名非空时显示「由 xxx 上架」） */
function ProductCard({
  product,
  balance,
  sellerName,
  onBuy,
  onDetail,
}: {
  product: PointProduct
  balance: number
  sellerName?: string | null
  onBuy: (p: PointProduct) => void
  /** 点击查看完整商品详情（用户反馈 4b720eeb：标题/描述过长看不全） */
  onDetail?: (p: PointProduct) => void
}) {
  const { t } = useT()
  // 「总量售罄」与「今日名额用完」是**两件事**，必须分开判断：
  //   · 总量售罄（stock<=0）→ 库存没了，说明天再来是错的，每日名额也失去意义；
  //   · 今日名额用完 → 总量可能还有（甚至不限量），明天确实能买。
  // 2026-10-06 用户反馈：「天卡卖完后还显示『今日剩 3 个』」—— 天卡 stock 已经是 0，
  // 但 dailySold 当天是 0（今天没人买过），每日名额从 3 起算，于是「已售罄」和
  // 「今日剩 3 个」两个徽标并排出现，看着就像卖完了还能买。
  const stockSoldOut = product.stock !== null && product.stock <= 0
  const dailyRemaining =
    product.dailyLimit != null
      ? Math.max(0, product.dailyLimit - (product.dailySold ?? 0))
      : null
  const dailySoldOut = dailyRemaining != null && dailyRemaining <= 0
  const soldOut = stockSoldOut || dailySoldOut
  const tooExpensive = product.price > balance
  const isRental = product.billingMode === "rental"
  return (
    <Card
      className="flex min-w-0 cursor-pointer flex-col"
      onClick={() => onDetail?.(product)}
    >
      <ProductCover imageUrl={product.imageUrl} icon={product.icon} name={product.name} />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardDescription className="min-w-0 truncate">
            {sellerName ? (
              <>
                {t("pt.bySeller", { name: sellerName })}
                {/* 快速联系卖家（2026-10-01）：问细节、催发货都从这进，
                    跟订单记录里的「发私信」是同一个会话 */}
                <Link
                  to={`/dashboard/dm/${encodeURIComponent(sellerName)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-1 whitespace-nowrap text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {t("pt.dm")}
                </Link>
              </>
            ) : (
              deliveryLabel(product.delivery)
            )}
          </CardDescription>
          <div className="flex shrink-0 items-center gap-1">
            {isRental && (
              <Badge variant="secondary" className="text-[10px]">
                <CalendarClock className="mr-0.5 h-2.5 w-2.5" />
                {rentalTerm(product.rentalDays)}
              </Badge>
            )}
            {product.stock !== null && (
              <Badge variant="outline" className="text-[10px]">
                {stockSoldOut
                  ? isRental
                    ? t("pt.rentedOut")
                    : t("pt.soldOut")
                  : isRental
                    ? t("pt.leftCopies", { n: product.stock })
                    : t("pt.leftPieces", { n: product.stock })}
              </Badge>
            )}
            {/* 总量已售罄时不显示每日名额：库存都没了，还说「今日剩 N 个」是误导 */}
            {product.dailyLimit != null && !stockSoldOut && (
              <Badge
                variant="outline"
                className={
                  dailySoldOut
                    ? "text-[10px] font-medium text-destructive"
                    : "text-[10px]"
                }
                title={t("pt.dailyLeftTitle")}
              >
                {dailySoldOut
                  ? t("pt.dailySoldOut")
                  : t("pt.dailyLeft", { n: dailyRemaining ?? 0 })}
              </Badge>
            )}
          </div>
        </div>
        <CardTitle className="flex items-center gap-1.5 text-base">
          <span className="min-w-0 truncate">{product.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            {t(PRODUCT_CATEGORY_LABELS[product.category] ?? PRODUCT_CATEGORY_LABELS.other)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        {product.description ? (
          // ⚠️ 必须 line-clamp + break-all：商品描述里常有一整段不带空格的链接，
          // 没有断行机会会一路把卡片撑爆（2026-10-01 用户反馈「描述过长超出卡片」）。
          // 点卡片任意位置（含图标/封面）都会打开完整详情弹窗，这里无需单独按钮。
          <p className="line-clamp-3 break-all whitespace-pre-wrap text-sm text-muted-foreground">
            {product.description}
          </p>
        ) : (
          <span />
        )}
        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">{product.price}</span>
            <span className="text-xs text-muted-foreground">
              {t("pt.unit")}
              {isRental ? ` / ${t("pt.days", { n: product.rentalDays ?? 0 })}` : ""}
              {product.delivery === "quota" && product.quotaYuan
                ? ` · ${t("pt.quotaFill", { v: fmtMoney(product.quotaYuan) })}`
                : ""}
              {product.perUserLimit ? ` · ${t("pt.perUserLimit", { n: product.perUserLimit })}` : ""}
            </span>
          </div>
          <Button
            className="w-full"
            variant={tooExpensive ? "outline" : "default"}
            disabled={soldOut}
            onClick={(e) => {
              e.stopPropagation()
              onBuy(product)
            }}
          >
            {soldOut
              ? stockSoldOut
                ? // 总量售罄：别提「明天再来」—— 明天也没货
                  isRental
                  ? t("pt.rentedOut")
                  : t("pt.soldOut")
                : // 今日名额用完：总量可能还有（甚至不限量），明天确实能买
                  t("pt.dailySoldOutBtn")
              : tooExpensive
                ? t("pt.insufficientShort")
                : isRental
                  ? t("pt.rental.rental")
                  : t("pt.buy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 上架 / 编辑自己商品时的表单 */
interface UploadForm {
  name: string
  description: string
  imageUrl: string
  icon: string
  category: ProductCategory
  price: string
  stock: string
  /**
   * 交付方式（2026-10-04 放开自动发货）：manual / code / content。
   * 卡密池内容不放在表单里 —— 池子有独立的管理面板（保存后追加）。
   */
  delivery: PointDelivery
  /** delivery='content' 的固定内容 */
  content: string
  /** 计费方式：买断 / 租用 */
  billingMode: PointBillingMode
  /** 租期天数（字符串，空 = 未填）；买断时忽略 */
  rentalDays: string
  enabled: boolean
}

/** 用户商品可选的交付方式（人工 / 卡密 / 固定内容；其余是平台能力不开放） */
const USER_DELIVERY_OPTIONS: readonly PointDelivery[] = ["manual", "code", "content"]

function emptyUpload(): UploadForm {
  return {
    name: "",
    description: "",
    imageUrl: "",
    icon: "",
    category: "other",
    price: "",
    stock: "",
    delivery: "manual",
    content: "",
    billingMode: "one_time",
    rentalDays: "",
    enabled: true,
  }
}

function uploadOf(p: PointProduct): UploadForm {
  return {
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl ?? "",
    icon: p.icon ?? "",
    category: p.category ?? "other",
    price: String(p.price),
    stock: p.stock === null ? "" : String(p.stock),
    delivery: USER_DELIVERY_OPTIONS.includes(p.delivery) ? p.delivery : "manual",
    content: p.deliveryParams?.content ?? "",
    billingMode: p.billingMode,
    rentalDays: p.rentalDays === null ? "" : String(p.rentalDays),
    enabled: p.enabled,
  }
}

function uploadPayload(f: UploadForm): UserProductPayload {
  const isRental = f.billingMode === "rental"
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    imageUrl: f.imageUrl.trim() || null,
    category: f.category,
    icon: f.icon.trim() || null,
    price: Math.trunc(Number(f.price) || 0),
    stock: f.stock.trim() === "" ? null : Math.trunc(Number(f.stock) || 0),
    delivery: f.delivery,
    // 只有固定内容商品的 deliveryParams 有意义；其余方式传 null，
    // 后端也只会读与 delivery 匹配的那个字段
    deliveryParams: f.delivery === "content" ? { content: f.content } : null,
    billingMode: f.billingMode,
    rentalDays: isRental ? Math.trunc(Number(f.rentalDays) || 0) : null,
    enabled: f.enabled,
  }
}

/** 租期快捷值（天）—— 覆盖「周 / 月 / 季 / 年」四个常见档位 */
const RENTAL_DAY_PRESETS = [7, 30, 90, 365] as const

/**
 * 卖家自己的卡密池管理（用户商品 delivery='code'）。
 *
 * 结构与管理端 CodeManager 相同，但接口走用户侧（后端校验所有权）。
 * 卡密本身不回显明文 —— 概览只有「可用 / 已用 / 共」三个数。
 */
function MyCodeManager({ productId }: { productId: string }) {
  const { t } = useT()
  const [info, setInfo] = React.useState<{
    total: number
    used: number
    available: number
  } | null>(null)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setInfo(await pointsApi.getMyProductCodes(productId))
    } catch (err) {
      toast.error(errMsg(err, t("pt.codes.loadFailed")))
    }
  }, [productId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    const codes = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (codes.length === 0) return
    setBusy(true)
    try {
      const r = await pointsApi.addMyProductCodes(productId, codes)
      toast.success(t("pt.codes.added", { n: r.added, avail: r.available }))
      setText("")
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.codes.addFailed")))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!confirm(t("pt.codes.confirmClear"))) return
    setBusy(true)
    try {
      const r = await pointsApi.clearMyProductCodes(productId)
      toast.success(t("pt.codes.cleared", { n: r.removed }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.codes.clearFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label>{t("pt.codes.title")}</Label>
        {info && (
          <span className="text-xs text-muted-foreground">
            {t("pt.codes.stats", {
              avail: info.available,
              used: info.used,
              total: info.total,
            })}
          </span>
        )}
      </div>
      <Textarea
        rows={4}
        placeholder={t("pt.codes.placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void add()}>
          {t("pt.codes.add")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !info?.available}
          onClick={() => void clear()}
        >
          {t("pt.codes.clear")}
        </Button>
      </div>
      {info && info.available === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("pt.codes.empty")}
        </p>
      )}
    </div>
  )
}

/** 「用户们的商城」每页商品数（3 列 × 3 行） */
const SHOP_PAGE_SIZE = 9

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
  MY_REVIEW,
  deliveryLabel,
  needsNewapiBinding,
  buyHint,
  rentalTerm,
  DeliveryContentBlock,
  isRentalExpired,
  rentalOrderText,
  rentalBuyHint,
  fmtMoney,
  ProductCover,
  SHOP_CAT_FILTERS,
  ProductCard,
  USER_DELIVERY_OPTIONS,
  emptyUpload,
  uploadOf,
  uploadPayload,
  RENTAL_DAY_PRESETS,
  MyCodeManager,
  SHOP_PAGE_SIZE,
}
export type { UploadForm }
