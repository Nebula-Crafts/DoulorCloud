import * as React from "react"
import { FeatureCardsSkeleton } from "@/components/skeletons"
import { Link } from "react-router-dom"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Eye,
  Flame,
  Loader2,
  Package,
  Pencil,
  Plus,
  ShoppingBag,
  Store,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { AnchoredPanel } from "@/components/anchored-panel"
import { EmptyState } from "@/components/empty-state"
import { ShopIconPicker } from "@/components/shop-icon-picker"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { pointsApi, errMsg, HttpError } from "@/services/api"
import { SectionEnter } from "@/components/motion/section-enter"
import { useAuth } from "@/hooks/use-auth"
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from "@/types"
import { notifyPointsChanged } from "@/components/points-badge"
import { fmtDateTime } from "@/lib/format"
import { shopIcon } from "@/lib/shop-icons"
import { FEATURE_LABELS } from "@/types"
import { useT, tStatic } from "@/i18n"
import type {
  PointOrder,
  PointProduct,
  PointsOverview,
  PublicPurchase,
} from "@/types"
import {
  AFTER_SALE_DIALOG,
  AFTER_SALE_STATUS,
  MY_REVIEW,
  ORDER_STATUS,
  SHOP_CAT_FILTERS,
  SHOP_PAGE_SIZE,
  DeliveryContentBlock,
  MyCodeManager,
  ProductCard,
  buyHint,
  canEscalateAfterSale,
  canRejectDelivery,
  canRequestAfterSale,
  canWithdrawAfterSale,
  emptyUpload,
  isRentalExpired,
  needsNewapiBinding,
  orderStatusText,
  rentalBuyHint,
  rentalOrderText,
  rentalTerm,
  uploadOf,
  uploadPayload,
} from "@/pages/pointshop-shared"

/**
 * 商城页（2026-11-06 自「积分与商城」拆出）。
 *
 * 官方商城 / 用户们的商城 / 我的交易 / 上架商品全在这里；
 * 积分余额、签到、转账、兑换、会员等级在 /dashboard/points。
 * 两页各自拉一次 overview —— 数据口径一致，互不依赖，方便独立改版。
 */
export default function ShopPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [data, setData] = React.useState<PointsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 购买弹窗
  const [buyTarget, setBuyTarget] = React.useState<PointProduct | null>(null)
  /** 商品详情弹窗（用户反馈 4b720eeb：标题/描述过长在卡片里看不全） */
  const [detailTarget, setDetailTarget] = React.useState<PointProduct | null>(null)
  /**
   * 详情弹窗里的「购买记录」（2026-10-08 站长要求）。
   *
   * 三态要分清：`null` = 这件商品没开公示（不渲染这块）/ 还没加载完，
   * `[]` = 开了公示但还没人买（渲染一句「暂无」）。后端对「没开公示」
   * 返回的是 404 而不是空数组，正是为了能区分这两种情况。
   */
  const [detailPurchases, setDetailPurchases] = React.useState<PublicPurchase[] | null>(null)
  const [buyBusy, setBuyBusy] = React.useState(false)

  // 我的商品 / 收到的订单
  const [mineOpen, setMineOpen] = React.useState(false)

  // 「用户们的商城」分页：服务端一次给全量（上限 200 个），在本地按 9 个一页切片
  const [shopPage, setShopPage] = React.useState(1)
  const shopTopRef = React.useRef<HTMLDivElement | null>(null)

  // 上架 / 编辑自己的商品
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<ReturnType<typeof emptyUpload>>(emptyUpload())
  const [formBusy, setFormBusy] = React.useState(false)
  /** 发布效果预览弹窗 */
  const [previewOpen, setPreviewOpen] = React.useState(false)

  // 封面图直传（2026-10-01）：传完把返回的同源 URL 填进 imageUrl，卖家不用再找图床
  const [coverUploading, setCoverUploading] = React.useState(false)
  const coverInputRef = React.useRef<HTMLInputElement | null>(null)

  // 售后（退款）：买家「申请退款」与卖家「拒绝并说明理由」共用一个对话框，用 mode 区分
  const [afterSaleTarget, setAfterSaleTarget] = React.useState<PointOrder | null>(null)
  const [afterSaleMode, setAfterSaleMode] = React.useState<
    "request" | "reject" | "rejectDelivery"
  >("request")
  const [afterSaleText, setAfterSaleText] = React.useState("")
  const [afterSaleBusy, setAfterSaleBusy] = React.useState(false)

  const handleCoverPick = async (file: File | undefined) => {
    if (!file) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error(t("pt.err.coverFormat"))
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t("pt.err.coverSize"))
      return
    }
    setCoverUploading(true)
    try {
      const res = await pointsApi.uploadProductImage(file)
      setForm((f) => ({ ...f, imageUrl: res.url }))
      toast.success(t("pt.toast.coverUploaded"))
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.coverUpload")))
    } finally {
      setCoverUploading(false)
      if (coverInputRef.current) coverInputRef.current.value = ""
    }
  }

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await pointsApi.overview())
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.load")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  /**
   * 商品详情弹窗打开时拉一次「购买记录」（仅当该商品开了公示）。
   *
   * ⚠️ 失败一律**静默**：商品没开公示时后端返回的就是 404，
   *    那是正常情况（详情里本就不该有这一块），弹 toast 反而像出错。
   *    拉不到就保持 null → 不渲染。
   */
  React.useEffect(() => {
    const target = detailTarget
    if (!target || !target.showPurchases) {
      setDetailPurchases(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await pointsApi.productPurchases(target.id)
        if (!cancelled) setDetailPurchases(res.purchases)
      } catch {
        if (!cancelled) setDetailPurchases(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [detailTarget])

  const balance = data?.balance ?? 0

  const buyIsUserProduct = !!buyTarget?.ownerId
  const buyTargetAffordable = !!buyTarget && buyTarget.price <= balance
  const buyTargetNeedsBind = !!buyTarget && needsNewapiBinding(buyTarget.delivery) && !data?.bound
  const canBuy = buyTargetAffordable && !buyTargetNeedsBind && !buyBusy

  const handleBuy = async () => {
    if (!buyTarget || !canBuy) return
    setBuyBusy(true)
    try {
      const res = await pointsApi.buy(buyTarget.id)
      const term =
        res.order.billingMode === "rental"
          ? t("pt.rental.termParen", { term: rentalTerm(res.order.rentalDays) })
          : ""
      // 有独立交付正文（统一内容 / 卡密）时，完整内容已由后端私聊发给买家，
      // 这里别再拿 note 硬塞 —— 弹窗一闪而过，买家根本来不及记（2026-10-06）。
      toast.success(
        res.order.status === "delivered"
          ? res.order.deliveryContent
            ? t("pt.toast.boughtAutoDm", { name: res.order.productName, term })
            : // 其余自动交付（充值 / 权限 / 订阅…）：note 就是「发了什么」的一句话
              t("pt.toast.boughtAuto", {
                name: res.order.productName,
                term,
                note: res.order.note ?? t("pt.autoDelivered"),
              })
          : res.order.sellerId
            ? t("pt.toast.boughtUser", { name: res.order.productName, term })
            : t("pt.toast.boughtManual", { name: res.order.productName, term })
      )
      setBuyTarget(null)
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.buy")))
    } finally {
      setBuyBusy(false)
    }
  }

  /** 买家确认收货 —— 把托管的积分结算给卖家 */
  const confirmReceipt = async (o: PointOrder) => {
    const rentalNote =
      o.billingMode === "rental"
        ? "\n\n" + t("pt.rental.noteFromReceipt", { n: o.rentalDays ?? "?" })
        : ""
    if (
      !confirm(
        t("pt.confirm.receipt", { name: o.productName, price: o.price, note: rentalNote })
      )
    )
      return
    try {
      await pointsApi.confirmReceipt(o.id)
      toast.success(t("pt.toast.receiptConfirmed"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      // 「已经结算过了」不是错误：说明上一次点击其实成功了，只是响应没回到前端
      //（或者用户连点了两下）。按成功处理并刷新，按钮才会消失 ——
      // 否则用户会看到「点一次报错、再点说确认过了、按钮还在」的诡异局面。
      if (err instanceof HttpError && err.code === "ALREADY_SETTLED") {
        toast.success(t("pt.toast.receiptConfirmed"))
        notifyPointsChanged()
        await load()
        return
      }
      toast.error(errMsg(err, t("pt.err.confirmReceipt")))
    }
  }

  // ---- 售后（退款）----

  /** 买家：打开「申请退款」对话框 */
  const openAfterSale = (o: PointOrder) => {
    setAfterSaleMode("request")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  /** 卖家：打开「拒绝退款」对话框（要写明理由，买家才服气） */
  const openAfterSaleReject = (o: PointOrder) => {
    setAfterSaleMode("reject")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  /** 买家：打开「拒收」对话框（没收到货 / 货不对板 → 直达平台介入） */
  const openRejectDelivery = (o: PointOrder) => {
    setAfterSaleMode("rejectDelivery")
    setAfterSaleText("")
    setAfterSaleTarget(o)
  }

  /** 提交对话框 —— 买家申请 / 卖家拒绝 / 买家拒收 共用 */
  const submitAfterSale = async () => {
    const o = afterSaleTarget
    if (!o) return
    const text = afterSaleText.trim()
    if ((afterSaleMode === "request" || afterSaleMode === "rejectDelivery") && text.length < 4) {
      toast.error(t("pt.afterSale.reasonTooShort"))
      return
    }
    if (afterSaleMode === "reject" && !text) {
      toast.error(t("pt.afterSale.rejectNeedReason"))
      return
    }
    setAfterSaleBusy(true)
    try {
      if (afterSaleMode === "request") {
        await pointsApi.requestAfterSale(o.id, text)
        toast.success(t("pt.toast.afterSaleRequested"))
      } else if (afterSaleMode === "rejectDelivery") {
        await pointsApi.rejectOrder(o.id, text)
        toast.success(t("pt.toast.rejected"))
      } else {
        await pointsApi.sellerResolveAfterSale(o.id, false, text)
        toast.success(t("pt.toast.afterSaleRejected"))
      }
      setAfterSaleTarget(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    } finally {
      setAfterSaleBusy(false)
    }
  }

  /** 卖家：同意退款（积分原路退回买家；卖家本就没拿到过这笔托管积分） */
  const approveAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmApprove", { name: o.productName, price: o.price }))) return
    try {
      await pointsApi.sellerResolveAfterSale(o.id, true)
      toast.success(t("pt.toast.afterSaleApproved"))
      notifyPointsChanged()
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  /** 买家：撤销自己的退款申请 */
  const withdrawAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmWithdraw"))) return
    try {
      await pointsApi.cancelAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleWithdrawn"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  /** 买家：卖家不处理或已拒绝 → 申请平台（管理员）介入 */
  const escalateAfterSale = async (o: PointOrder) => {
    if (!confirm(t("pt.afterSale.confirmEscalate"))) return
    try {
      await pointsApi.escalateAfterSale(o.id)
      toast.success(t("pt.toast.afterSaleEscalated"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.afterSale")))
    }
  }

  // ---- 我的商品 ----

  const openUpload = () => {
    setEditingId(null)
    setForm(emptyUpload())
    setUploadOpen(true)
  }

  const openEditMine = (p: PointProduct) => {
    setEditingId(p.id)
    setForm(uploadOf(p))
    setUploadOpen(true)
  }

  /** 发布效果预览：用当前表单值拼一个 PointProduct，直接复用商品卡片渲染 */
  const previewProduct: PointProduct | null = React.useMemo(() => {
    if (!previewOpen) return null
    const p = uploadPayload(form)
    const now = new Date().toISOString()
    return {
      id: "__preview__",
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      category: p.category,
      icon: p.icon,
      price: p.price,
      stock: p.stock,
      dailyLimit: null,
      dailyPerUserLimit: null,
      dailySold: 0,
      // 预览的是「尚未发布」的商品 ⇒ 累计售出必然是 0
      soldCount: 0,
      // 用户自己上架的商品没有「公示购买记录」开关（那是管理员在商品设置里逐件开的，
      // 且刚发布时本来也还没有任何购买记录），预览里恒为 false
      showPurchases: false,
      perUserLimit: null,
      // 用户商品交付方式固定为人工
      delivery: "manual",
      quotaYuan: null,
      deliveryParams: null,
      enabled: p.enabled,
      sort: 0,
      ownerId: "__preview__",
      ownerName: user?.username ?? null,
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null,
      billingMode: p.billingMode,
      rentalDays: p.rentalDays,
      createdAt: now,
      updatedAt: now,
    }
  }, [previewOpen, form, user])

  const submitUpload = async () => {
    const payload = uploadPayload(form)
    if (!payload.name) {
      toast.error(t("pt.err.nameRequired"))
      return
    }
    if (payload.price < 1) {
      toast.error(t("pt.err.priceInvalid"))
      return
    }
    if (payload.billingMode === "rental" && (!payload.rentalDays || payload.rentalDays < 1)) {
      toast.error(t("pt.err.rentalDaysRequired"))
      return
    }
    // 固定内容商品：内容为空 = 买家花积分买到空气
    if (payload.delivery === "content" && !payload.deliveryParams?.content?.trim()) {
      toast.error(t("pt.err.contentRequired"))
      return
    }
    setFormBusy(true)
    try {
      if (editingId) {
        await pointsApi.updateMyProduct(editingId, payload)
        toast.success(t("pt.toast.savedReview"))
      } else {
        await pointsApi.uploadProduct(payload)
        toast.success(t("pt.toast.submitted"))
      }
      setUploadOpen(false)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.submit")))
    } finally {
      setFormBusy(false)
    }
  }

  const removeMine = async (p: PointProduct) => {
    if (!confirm(t("pt.confirm.deleteMine", { name: p.name }))) return
    try {
      await pointsApi.deleteMyProduct(p.id)
      toast.success(t("pt.toast.deleted"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.delete")))
    }
  }

  const sellerDeliver = async (o: PointOrder) => {
    if (!confirm(t("pt.confirm.deliver", { name: o.productName }))) return
    try {
      await pointsApi.sellerDeliver(o.id)
      toast.success(t("pt.toast.delivered"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("pt.err.op")))
    }
  }

  const orders: PointOrder[] = data?.orders ?? []
  const myProducts: PointProduct[] = data?.myProducts ?? []
  const userProducts: PointProduct[] = data?.userProducts ?? []
  /** 用户商城的分类筛选：all / it / other */
  const [shopCat, setShopCat] = React.useState<ProductCategory | "all">("all")
  /** 官方商城自己的排序/有货开关（2026-10-05 站长要求：两个商城分开起作用） */
  const [officialSort, setOfficialSort] = React.useState<"default" | "hot">("default")
  const [officialStockOnly, setOfficialStockOnly] = React.useState(false)
  /** 用户商城自己的排序/有货开关 */
  const [shopSort, setShopSort] = React.useState<"default" | "hot">("default")
  const [shopStockOnly, setShopStockOnly] = React.useState(false)

  /** 「热度排序 + 只看有货」，官方与用户商城各用各的开关 */
  const applyControls = (
    list: PointProduct[],
    sort: "default" | "hot",
    stockOnly: boolean
  ): PointProduct[] => {
    let out = stockOnly ? list.filter((p) => p.stock === null || p.stock > 0) : list
    if (sort === "hot") out = [...out].sort((a, b) => b.soldCount - a.soldCount)
    return out
  }

  const shownUserProducts = applyControls(
    shopCat === "all" ? userProducts : userProducts.filter((p) => p.category === shopCat),
    shopSort,
    shopStockOnly
  )
  const sellerOrders: PointOrder[] = data?.sellerOrders ?? []

  /** 用户商城的页码：商品变少导致页码越界（如删到只剩 1 页）时自动收回到最后一页 */
  const shopPageCount = Math.max(1, Math.ceil(shownUserProducts.length / SHOP_PAGE_SIZE))
  const shopPageSafe = Math.min(shopPage, shopPageCount)
  const pagedUserProducts = shownUserProducts.slice(
    (shopPageSafe - 1) * SHOP_PAGE_SIZE,
    shopPageSafe * SHOP_PAGE_SIZE
  )

  /** 翻页后把商城标题滚回视野 —— 否则新一页全在视口上方，看着像没反应 */
  const gotoShopPage = (p: number) => {
    setShopPage(p)
    shopTopRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
  /** 需要我处理的：别人买了我的东西但还没交付 */
  const todoSellerOrders = sellerOrders.filter((o) => o.status === "pending").length
  /** 需要我确认收货的 */
  const todoConfirm = orders.filter((o) => o.sellerId !== null && o.status === "delivered").length
  /** 一共几件事等着我动手（发货 + 收货），用于卡片角标 */
  const todoCount = todoSellerOrders + todoConfirm

  /** 「我的交易」二级菜单：顶部按钮 → 下拉分类 → 点分类弹窗看明细（2026-10-03 站长要求） */
  const [tradesMenuOpen, setTradesMenuOpen] = React.useState(false)
  const tradesBtnRef = React.useRef<HTMLDivElement | null>(null)
  const [tradesView, setTradesView] = React.useState<null | "todo" | "bought" | "sold">(null)
  const openTradesView = (v: "todo" | "bought" | "sold") => {
    setTradesMenuOpen(false)
    setTradesView(v)
  }

  /**
   * 续费：找到订单对应的商品，重新走一遍购买流程。
   *
   * 只从「正在卖的商品」里找（官方上架 + 用户已通过审核）—— 商品下架或删除后就续不了，
   * 这时按钮不显示。续费本身由服务端处理成「从原到期时间往后顺延」。
   */
  const renewTarget = (o: PointOrder): PointProduct | null => {
    if (!o.productId || o.billingMode !== "rental" || o.status === "cancelled") return null
    return (
      data?.products.find((p) => p.id === o.productId) ??
      data?.userProducts.find((p) => p.id === o.productId) ??
      null
    )
  }

  /**
   * 「我的交易」三个分区的渲染。原先这三块是页面底部一张大卡片，
   * 2026-10-03 站长要求收进顶部「我的交易」按钮的二级菜单里（点分类再弹窗看）。
   * 抽成渲染函数是为了弹窗里复用同一套 UI（含卖家发货 / 买家收货 / 售后等操作）。
   */
  const renderTodoList = () => (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <ul className="space-y-2">
        {sellerOrders
          .filter((o) => o.status === "pending")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {t("pt.todo.ship", { name: o.productName })}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.shipMeta", { user: o.username, n: o.price })}
                </p>
              </div>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void sellerDeliver(o)}
              >
                {t("pt.markDelivered")}
              </Button>
            </li>
          ))}
        {orders
          .filter((o) => o.sellerId !== null && o.status === "delivered")
          .map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {t("pt.todo.receive", { name: o.productName })}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.todo.receiveMeta", {
                    seller: o.sellerName ?? "?",
                    price: o.price,
                  })}
                </p>
              </div>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void confirmReceipt(o)}
              >
                {t("pt.confirmReceipt")}
              </Button>
            </li>
          ))}
      </ul>
    </div>
  )

  const renderBoughtList = () =>
    orders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.boughtEmpty")}
      </p>
    ) : (
      <ul className="divide-y">
        {orders.map((o) => {
          const isUserOrder = o.sellerId !== null
          const st = ORDER_STATUS[o.status] ?? ORDER_STATUS.pending
          const rental = rentalOrderText(o)
          const expired = isRentalExpired(o)
          const renew = renewTarget(o)
          return (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {o.productName}
                  {o.billingMode === "rental" && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {rentalTerm(o.rentalDays)}
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {fmtDateTime(o.createdAt)}
                  {isUserOrder ? ` · ${t("pt.sellerLabel")} ${o.sellerName ?? "?"}` : ""}
                  {/* 交易双方能互相联系（2026-10-01）：交付方式、催确认收货都靠它 */}
                  {isUserOrder && o.sellerName && (
                    <>
                      {" · "}
                      <Link
                        to={`/dashboard/dm/${encodeURIComponent(o.sellerName)}`}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {t("pt.sendDm")}
                      </Link>
                    </>
                  )}
                  {o.note ? ` · ${o.note}` : ""}
                </p>
                {(o.afterSaleReason || o.afterSaleNote) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {o.afterSaleReason
                      ? `${t("pt.afterSale.reasonLabel")}${o.afterSaleReason}`
                      : ""}
                    {o.afterSaleReason && o.afterSaleNote ? " · " : ""}
                    {o.afterSaleNote
                      ? `${t("pt.afterSale.noteLabel")}${o.afterSaleNote}`
                      : ""}
                  </p>
                )}
                {rental && (
                  <p
                    className={
                      expired
                        ? "text-xs font-medium text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {rental}
                  </p>
                )}
                {/*
                  自动发货的正文（统一内容 / 卡密）：这是买家**买到的东西**，
                  必须能反复查看、能直接复制，所以单列一块而不是塞进上面那行摘要。
                  只在还没退款/取消的订单上显示 —— 已退款的把内容再摆出来没意义。
                */}
                {o.deliveryContent && o.status !== "cancelled" && (
                  <DeliveryContentBlock content={o.deliveryContent} />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <div>
                  <p className="text-sm font-medium tabular-nums text-muted-foreground">
                    -{o.price}
                  </p>
                  <div className="mt-0.5 flex flex-col items-end gap-1">
                    <Badge variant={st.variant} className="text-[10px]">
                      {t(orderStatusText(o.status, isUserOrder))}
                    </Badge>
                    {o.afterSaleStatus && (
                      <Badge
                        variant={AFTER_SALE_STATUS[o.afterSaleStatus].variant}
                        className="text-[10px]"
                      >
                        {t(AFTER_SALE_STATUS[o.afterSaleStatus].label)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {isUserOrder && o.status === "delivered" && (
                    <Button size="sm" onClick={() => void confirmReceipt(o)}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t("pt.confirmReceipt")}
                    </Button>
                  )}
                  {canRequestAfterSale(o) && (
                    <Button size="sm" variant="outline" onClick={() => openAfterSale(o)}>
                      {t("pt.afterSale.request")}
                    </Button>
                  )}
                  {canRejectDelivery(o) && (
                    <Button size="sm" variant="outline" onClick={() => openRejectDelivery(o)}>
                      {t("pt.afterSale.rejectDelivery")}
                    </Button>
                  )}
                  {canEscalateAfterSale(o) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void escalateAfterSale(o)}
                    >
                      {t("pt.afterSale.escalate")}
                    </Button>
                  )}
                  {canWithdrawAfterSale(o) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void withdrawAfterSale(o)}
                    >
                      {t("pt.afterSale.withdraw")}
                    </Button>
                  )}
                </div>
                {renew && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBuyTarget(renew)}
                    title={expired ? t("pt.renewExpiredTip") : t("pt.renewTip")}
                  >
                    <Package className="mr-1 h-3.5 w-3.5" />
                    {t("pt.renew")}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    )

  const renderSoldList = () =>
    sellerOrders.length === 0 ? (
      <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
        {t("pt.soldEmpty")}
      </p>
    ) : (
      <ul className="divide-y rounded-md border">
        {sellerOrders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {o.productName}
                {o.billingMode === "rental" && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">
                    {rentalTerm(o.rentalDays)}
                  </Badge>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t("pt.soldMeta", { user: o.username, time: fmtDateTime(o.createdAt) })}
                {" · "}
                <Link
                  to={`/dashboard/dm/${encodeURIComponent(o.username)}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {t("pt.sendDm")}
                </Link>
                {o.note ? ` · ${o.note}` : ""}
              </p>
              {o.afterSaleReason && (
                <p className="truncate text-xs text-amber-600 dark:text-amber-400">
                  {t("pt.afterSale.buyerReason")}
                  {o.afterSaleReason}
                </p>
              )}
              {o.afterSaleNote && o.afterSaleStatus !== "requested" && (
                <p className="truncate text-xs text-muted-foreground">
                  {t("pt.afterSale.noteLabel")}
                  {o.afterSaleNote}
                </p>
              )}
              {rentalOrderText(o) && (
                <p className="text-xs text-muted-foreground">{rentalOrderText(o)}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium tabular-nums">+{o.price}</span>
              <div className="flex flex-col items-end gap-1">
                {o.status === "pending" ? (
                  <Button size="sm" onClick={() => void sellerDeliver(o)}>
                    {t("pt.markDelivered")}
                  </Button>
                ) : (
                  <Badge
                    variant={(ORDER_STATUS[o.status] ?? ORDER_STATUS.pending).variant}
                    className="text-[10px]"
                  >
                    {t(orderStatusText(o.status, true))}
                  </Badge>
                )}
                {o.afterSaleStatus && (
                  <Badge
                    variant={AFTER_SALE_STATUS[o.afterSaleStatus].variant}
                    className="text-[10px]"
                  >
                    {t(AFTER_SALE_STATUS[o.afterSaleStatus].label)}
                  </Badge>
                )}
                {o.afterSaleStatus === "requested" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void approveAfterSale(o)}
                    >
                      {t("pt.afterSale.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openAfterSaleReject(o)}
                    >
                      {t("pt.afterSale.reject")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    )

  return (
    <div>
      <PageHeader
        title={t("shop.pageTitle")}
        description={t("shop.pageDesc")}
        actions={
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Coins className="h-4 w-4 text-primary" />
              {balance}
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <Package className="mr-1.5 h-3.5 w-3.5" />
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      {loading && !data ? (
        <FeatureCardsSkeleton />
      ) : !data ? (
        <EmptyState
          title={t("pt.loadFailed")}
          description={t("pt.loadFailedDesc")}
          action={<Button onClick={() => void load()}>{t("common.retry")}</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* 我的交易：收进顶部按钮的二级菜单里（原积分页同款，随拆分整体迁来） */}
          <div className="flex flex-wrap items-center gap-2">
            <div ref={tradesBtnRef} className="relative">
              <Button
                variant="default"
                size="sm"
                onClick={() => setTradesMenuOpen((v) => !v)}
              >
                <Package className="mr-1.5 h-3.5 w-3.5" />
                {t("pt.myTrades")}
                {todoCount > 0 && (
                  <Badge
                    variant="default"
                    className="ml-1.5 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
                  >
                    {todoCount}
                  </Badge>
                )}
                <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
              </Button>
              <AnchoredPanel
                anchorRef={tradesBtnRef}
                open={tradesMenuOpen}
                onClose={() => setTradesMenuOpen(false)}
                width={208}
                height={172}
              >
                <div className="space-y-0.5 p-1">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("todo")}
                  >
                    <span>{t("pt.todoTitle")}</span>
                    {todoCount > 0 && (
                      <Badge variant="default" className="text-[10px]">
                        {todoCount}
                      </Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("bought")}
                  >
                    {t("pt.boughtTitle", { n: orders.length })}
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => openTradesView("sold")}
                  >
                    {t("pt.soldTitle", { n: sellerOrders.length })}
                  </button>
                </div>
              </AnchoredPanel>
            </div>
          </div>

          {/* 官方商城 */}
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">{t("pt.officialShop")}</h2>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={officialSort === "hot" ? "default" : "outline"}
                  onClick={() => setOfficialSort((s) => (s === "hot" ? "default" : "hot"))}
                >
                  <Flame className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.sortHot")}
                </Button>
                <Button
                  size="sm"
                  variant={officialStockOnly ? "default" : "outline"}
                  onClick={() => setOfficialStockOnly((v) => !v)}
                >
                  <Package className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.inStockOnly")}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {applyControls(data.products, officialSort, officialStockOnly).map((p) => (
                <ProductCard key={p.id} product={p} balance={balance} onBuy={setBuyTarget} onDetail={setDetailTarget} />
              ))}
            </div>
          </div>

          {/* 用户们的商城 */}
          <div>
            <div ref={shopTopRef} className="mb-3 flex flex-wrap items-center gap-2 scroll-mt-20">
              <Store className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">{t("pt.userShop")}</h2>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setMineOpen(true)}>
                  <Package className="mr-1.5 h-3.5 w-3.5" />
                  {t("pt.myProducts")}
                  {myProducts.length > 0 && ` (${myProducts.length})`}
                </Button>
                <Button size="sm" onClick={openUpload}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("pt.uploadProduct")}
                </Button>
              </div>
            </div>

            <p className="mb-3 text-xs text-muted-foreground">
              {t("pt.userShopDesc")}
            </p>

            {/* 分类筛选（2026-10-03 站长要求：「其他」的商品默认排在后面） */}
            <div className="mb-3 flex flex-wrap gap-2">
              {SHOP_CAT_FILTERS.map((f) => (
                <Button
                  key={f.key}
                  size="sm"
                  variant={shopCat === f.key ? "default" : "outline"}
                  onClick={() => setShopCat(f.key)}
                >
                  {t(f.label)}
                </Button>
              ))}
              <span className="mx-1 hidden w-px self-stretch bg-border sm:block" />
              <Button
                size="sm"
                variant={shopSort === "hot" ? "default" : "outline"}
                onClick={() => {
                  setShopPage(1)
                  setShopSort((s) => (s === "hot" ? "default" : "hot"))
                }}
              >
                <Flame className="mr-1.5 h-3.5 w-3.5" />
                {t("pt.sortHot")}
              </Button>
              <Button
                size="sm"
                variant={shopStockOnly ? "default" : "outline"}
                onClick={() => {
                  setShopPage(1)
                  setShopStockOnly((v) => !v)
                }}
              >
                <Package className="mr-1.5 h-3.5 w-3.5" />
                {t("pt.inStockOnly")}
              </Button>
            </div>

            {userProducts.length === 0 ? (
              <EmptyState
                icon={Store}
                title={t("pt.userShopEmpty")}
                description={t("pt.userShopEmptyDesc")}
              />
            ) : (
              /* 动效层：分类/排序/筛选/翻页变化时整组卡片重新错峰入场
                 （开关关闭时类还在但规则不命中，行为与现状一致） */
              <SectionEnter
                watch={`${shopCat}|${shopSort}|${shopStockOnly}|${shopPageSafe}`}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {pagedUserProducts.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    balance={balance}
                    sellerName={p.ownerName}
                    onBuy={setBuyTarget}
                    onDetail={setDetailTarget}
                  />
                ))}
              </SectionEnter>
            )}

            {/* 分页：每页 9 个（3 列 × 3 行），只有一页时不显示 */}
            {shopPageCount > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shopPageSafe <= 1}
                  onClick={() => gotoShopPage(shopPageSafe - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t("pt.shopPrev")}
                </Button>
                <span className="tabular-nums">
                  {t("pt.shopPageInfo", {
                    page: shopPageSafe,
                    pages: shopPageCount,
                    n: userProducts.length,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shopPageSafe >= shopPageCount}
                  onClick={() => gotoShopPage(shopPageSafe + 1)}
                >
                  {t("pt.shopNext")}
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>

          {/* 我的交易：二级菜单点开后的弹窗 */}
          <Dialog
            open={tradesView !== null}
            onOpenChange={(o) => {
              if (!o) setTradesView(null)
            }}
          >
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {tradesView === "todo"
                    ? t("pt.todoTitle")
                    : tradesView === "bought"
                      ? t("pt.boughtTitle", { n: orders.length })
                      : t("pt.soldTitle", { n: sellerOrders.length })}
                </DialogTitle>
                <DialogDescription>{t("pt.tradesDesc")}</DialogDescription>
              </DialogHeader>
              {tradesView === "todo" ? (
                todoCount > 0 ? (
                  renderTodoList()
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {t("pt.todoNone")}
                  </p>
                )
              ) : tradesView === "bought" ? (
                renderBoughtList()
              ) : (
                renderSoldList()
              )}
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* 售后（退款）：买家「申请退款」与卖家「拒绝并说明理由」共用一个对话框 */}
      <Dialog
        open={afterSaleTarget !== null}
        onOpenChange={(v) => {
          if (!v) setAfterSaleTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t(AFTER_SALE_DIALOG[afterSaleMode].title)}</DialogTitle>
            <DialogDescription>{t(AFTER_SALE_DIALOG[afterSaleMode].desc)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="afterSaleText">{t(AFTER_SALE_DIALOG[afterSaleMode].label)}</Label>
            <Textarea
              id="afterSaleText"
              value={afterSaleText}
              onChange={(e) => setAfterSaleText(e.target.value)}
              maxLength={300}
              rows={3}
              placeholder={t(AFTER_SALE_DIALOG[afterSaleMode].placeholder)}
            />
            {afterSaleTarget && (
              <p className="text-xs text-muted-foreground">
                {afterSaleTarget.productName} ·{" "}
                {t("pt.pointsUnit", { n: afterSaleTarget.price })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAfterSaleTarget(null)}
              disabled={afterSaleBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitAfterSale()} disabled={afterSaleBusy}>
              {afterSaleBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t("pt.afterSale.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 购买弹窗 */}
      <Dialog open={!!buyTarget} onOpenChange={(o) => !o && !buyBusy && setBuyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buyTarget?.billingMode === "rental" ? tStatic("pt.rental.rental") : t("pt.buy")} · {buyTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {buyHint(buyTarget?.delivery ?? "manual", buyIsUserProduct)}
              {buyTarget?.billingMode === "rental" && (
                <> {rentalBuyHint(buyTarget.rentalDays, buyIsUserProduct)}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {buyIsUserProduct && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.sellerLabel")}</span>
                <span className="font-medium">{buyTarget?.ownerName ?? "—"}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.priceLabel")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: buyTarget?.price ?? 0 })}
                {buyTarget?.billingMode === "rental"
                  ? ` / ${t("pt.days", { n: buyTarget.rentalDays ?? 0 })}`
                  : ""}
              </span>
            </div>
            {buyTarget?.billingMode === "rental" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.billingLabel")}</span>
                <span className="font-medium">{t("pt.billingRental")}</span>
              </div>
            )}
            {buyTarget?.delivery === "quota" && buyTarget.quotaYuan ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.quotaAmount")}</span>
                <span className="font-medium tabular-nums">
                  ¥{(buyTarget.quotaYuan).toFixed(2)}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "feature" && buyTarget.deliveryParams?.feature ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.featureLabel")}</span>
                <span className="font-medium">
                  {t(FEATURE_LABELS[buyTarget.deliveryParams.feature])}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "subscription" && buyTarget.deliveryParams?.planId ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.planLabel")}</span>
                <span className="font-medium tabular-nums">
                  #{buyTarget.deliveryParams.planId}
                </span>
              </div>
            ) : null}
            {buyTarget?.delivery === "invite_quota" && buyTarget.deliveryParams?.count ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("pt.inviteQuotaLabel")}</span>
                <span className="font-medium tabular-nums">
                  {t("pt.countUnit", { n: buyTarget.deliveryParams.count })}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("pt.balanceAfter")}</span>
              <span className="font-medium tabular-nums">
                {t("pt.pointsUnit", { n: balance - (buyTarget?.price ?? 0) })}
              </span>
            </div>
            {buyTargetNeedsBind && (
              <p className="text-xs text-destructive">
                {buyTarget?.delivery === "subscription"
                  ? t("pt.needBind.subscription")
                  : t("pt.needBind.quota")}
              </p>
            )}
            {!buyTargetAffordable && (
              <p className="text-xs text-destructive">{t("pt.insufficient")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyTarget(null)} disabled={buyBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleBuy()} disabled={!canBuy}>
              {buyBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("pt.confirmBuy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 商品详情：完整标题 + 描述（卡片里被截断，这里看全文） */}
      <Dialog open={!!detailTarget} onOpenChange={(o) => !o && setDetailTarget(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-all">{detailTarget?.name}</DialogTitle>
            <DialogDescription>{t("pt.detailTitle")}</DialogDescription>
          </DialogHeader>
          {detailTarget && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="text-lg font-semibold tabular-nums">{detailTarget.price}</span>
                <span className="text-xs text-muted-foreground">
                  {t("pt.unit")}
                  {detailTarget.billingMode === "rental"
                    ? ` / ${t("pt.days", { n: detailTarget.rentalDays ?? 0 })}`
                    : ""}
                  {detailTarget.perUserLimit
                    ? ` · ${t("pt.perUserLimit", { n: detailTarget.perUserLimit })}`
                    : ""}
                  {/* 与卡片同一口径：总量售罄优先 —— 库存都没了还说「今日剩 N 个」是误导 */}
                  {detailTarget.stock !== null && detailTarget.stock <= 0
                    ? ` · ${
                        detailTarget.billingMode === "rental"
                          ? t("pt.rentedOut")
                          : t("pt.soldOut")
                      }`
                    : detailTarget.dailyLimit != null
                      ? ` · ${
                          detailTarget.dailyLimit - (detailTarget.dailySold ?? 0) > 0
                            ? t("pt.dailyLeft", {
                                n: Math.max(0, detailTarget.dailyLimit - (detailTarget.dailySold ?? 0)),
                              })
                            : t("pt.dailySoldOut")
                        }`
                      : ""}
                </span>
              </div>
              {detailTarget.description ? (
                <p className="whitespace-pre-wrap break-all text-sm text-muted-foreground">
                  {detailTarget.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("pt.detailNoDesc")}</p>
              )}

              {/* 购买记录公示（2026-10-08 站长要求）：只有商品开了公示才有内容 ——
                  没开时后端返回 404，detailPurchases 保持 null，这里整块不渲染。 */}
              {detailPurchases && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("pt.purchasesTitle")}</p>
                  {detailPurchases.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("pt.purchasesEmpty")}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {detailPurchases.map((p, i) => (
                        <li
                          key={`${p.username}-${p.createdAt}-${i}`}
                          className="flex items-baseline justify-between gap-3 text-xs"
                        >
                          <span className="min-w-0 truncate font-medium">{p.username}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {fmtDateTime(p.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[11px] text-muted-foreground">{t("pt.purchasesHint")}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailTarget(null)}>
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                if (detailTarget) {
                  setBuyTarget(detailTarget)
                  setDetailTarget(null)
                }
              }}
            >
              {t("pt.buy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 我的商品 + 我收到的订单 */}
      <Dialog open={mineOpen} onOpenChange={setMineOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("pt.myProducts")}</DialogTitle>
            <DialogDescription>{t("pt.myProductsDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{t("pt.listedTitle", { n: myProducts.length })}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setMineOpen(false)
                    openUpload()
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("pt.uploadNew")}
                </Button>
              </div>

              {myProducts.length === 0 ? (
                <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  {t("pt.listedEmpty")}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {myProducts.map((p) => {
                    const rv = MY_REVIEW[p.reviewStatus] ?? MY_REVIEW.pending
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 p-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
                            {p.imageUrl ? (
                              <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              (() => {
                                const I = shopIcon(p.icon)
                                return <I className="h-4 w-4 text-primary" />
                              })()
                            )}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {t("pt.pointsUnit", { n: p.price })}
                              {p.billingMode === "rental"
                                ? ` / ${t("pt.days", { n: p.rentalDays ?? 0 })}`
                                : ""}{" "}
                              ·{" "}
                              {p.stock === null
                                ? t("pt.unlimited")
                                : t("pt.leftPieces", { n: p.stock })}
                              {!p.enabled ? t("pt.delisted") : ""}
                            </p>
                            {p.reviewStatus === "rejected" && p.reviewNote && (
                              <p className="mt-0.5 text-xs text-destructive">
                                {t("pt.rejectedNote", { note: p.reviewNote })}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge variant={rv.variant} className="text-[10px]">
                            {t(rv.label)}
                          </Badge>
                          <Button variant="outline" size="sm" onClick={() => openEditMine(p)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void removeMine(p)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 上架 / 编辑自己的商品 */}
      <Dialog open={uploadOpen} onOpenChange={(o) => !formBusy && setUploadOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? t("pt.editMine") : t("pt.uploadMine")}</DialogTitle>
            <DialogDescription>{t("pt.uploadDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="upName">{t("pt.form.name")}</Label>
              <Input
                id="upName"
                maxLength={40}
                placeholder={t("pt.form.namePlaceholder")}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="upDesc">{t("pt.form.desc")}</Label>
              <Textarea
                id="upDesc"
                rows={3}
                maxLength={500}
                placeholder={t("pt.form.descPlaceholder")}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="upImage">{t("pt.form.cover")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={coverUploading}
                  onClick={() => coverInputRef.current?.click()}
                >
                  {coverUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {t("pt.form.localUpload")}
                </Button>
                {/* 隐藏的文件选择：传完立即把返回的 URL 填进下面的输入框 */}
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => void handleCoverPick(e.target.files?.[0])}
                />
              </div>
              <Input
                id="upImage"
                placeholder={t("pt.form.coverPlaceholder")}
                value={form.imageUrl}
                onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              />
              {form.imageUrl.trim() && (
                <p className="text-xs text-muted-foreground">
                  {t("pt.form.coverHint")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="upCategory">{t("pt.form.category")}</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as ProductCategory }))}
              >
                <SelectTrigger id="upCategory" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRODUCT_CATEGORY_LABELS) as ProductCategory[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(PRODUCT_CATEGORY_LABELS[c])}
                      </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("pt.form.categoryHint")}
              </p>
            </div>

            <ShopIconPicker
              value={form.icon}
              disabled={formBusy}
              onChange={(slug) => setForm((f) => ({ ...f, icon: slug }))}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="upPrice">{t("pt.form.price")}</Label>
                <Input
                  id="upPrice"
                  inputMode="numeric"
                  placeholder={t("pt.form.pricePlaceholder")}
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upStock">
                  {form.billingMode === "rental" ? t("pt.form.stockRental") : t("pt.form.stock")}
                </Label>
                <Input
                  id="upStock"
                  inputMode="numeric"
                  placeholder={t("pt.form.unlimited")}
                  value={form.stock}
                  onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                />
              </div>
            </div>

            {/* 交付方式：人工 / 卡密 / 固定内容（2026-10-04 放开自动发货）。
                其余自动方式（权限 / 订阅 / 额度）是平台能力，不开放给用户商品。 */}
            <div className="space-y-2">
              <Label>{t("pt.form.delivery")}</Label>
              <div className="flex flex-wrap gap-2">
                {SHOP_USER_DELIVERY_OPTIONS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={form.delivery === d ? "default" : "outline"}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        delivery: d,
                        // 卡密/固定内容是一次性发放，不能租用 —— 切过去时顺手关掉租用
                        billingMode:
                          d !== "manual" && f.billingMode === "rental" ? "one_time" : f.billingMode,
                      }))
                    }
                  >
                    {t(
                      d === "manual"
                        ? "pt.delivery.manual"
                        : d === "code"
                          ? "pt.delivery.code"
                          : "pt.delivery.content"
                    )}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  form.delivery === "manual"
                    ? "pt.form.deliveryHint.manual"
                    : form.delivery === "code"
                      ? "pt.form.deliveryHint.code"
                      : "pt.form.deliveryHint.content"
                )}
              </p>
            </div>

            {/* 固定内容：交付正文（人人相同，如网盘链接） */}
            {form.delivery === "content" && (
              <div className="space-y-2">
                <Label htmlFor="upContent">{t("pt.form.contentLabel")}</Label>
                <Textarea
                  id="upContent"
                  rows={6}
                  placeholder={t("pt.form.contentPlaceholder")}
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("pt.form.contentHint", { n: form.content.length })}
                </p>
              </div>
            )}

            {/* 卡密：保存后在这里维护卡密池（一行一条，每人一条互不相同） */}
            {form.delivery === "code" && (
              <div className="space-y-2">
                {editingId ? (
                  <MyCodeManager productId={editingId} />
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("pt.form.codesSaveFirst")}
                  </p>
                )}
              </div>
            )}

            {/* 计费方式：买断 / 租用。只有人工交付的商品可租（卡密 / 固定内容是一次性发放，收不回来） */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("pt.form.rentalMode")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("pt.form.rentalModeHint")}
                  </p>
                </div>
                <Switch
                  checked={form.billingMode === "rental"}
                  disabled={form.delivery !== "manual"}
                  onCheckedChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      billingMode: v ? "rental" : "one_time",
                      // 打开时给个默认租期，省得忘了填被服务端打回
                      rentalDays: v && !f.rentalDays ? "30" : f.rentalDays,
                    }))
                  }
                />
              </div>

              {form.billingMode === "rental" && (
                <div className="space-y-2">
                  <Label htmlFor="upDays">{t("pt.form.rentalDays")}</Label>
                  <Input
                    id="upDays"
                    inputMode="numeric"
                    placeholder={t("pt.form.rentalDaysPlaceholder")}
                    value={form.rentalDays}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, rentalDays: e.target.value.replace(/\D/g, "") }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    {RENTAL_PRESETS.map((d) => (
                      <Button
                        key={d}
                        type="button"
                        size="sm"
                        variant={form.rentalDays === String(d) ? "default" : "outline"}
                        onClick={() => setForm((f) => ({ ...f, rentalDays: String(d) }))}
                      >
                        {t("pt.days", { n: d })}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("pt.form.enabled")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("pt.form.enabledHint")}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewOpen(true)}
              disabled={formBusy}
            >
              <Eye className="mr-1.5 h-4 w-4" />
              {t("pt.preview.open")}
            </Button>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={formBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitUpload()} disabled={formBusy}>
              {formBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {editingId ? t("common.save") : t("pt.submitReview")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 发布效果预览：复用商品卡片，按当前表单值实时渲染 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("pt.preview.title")}</DialogTitle>
            <DialogDescription>{t("pt.preview.hint")}</DialogDescription>
          </DialogHeader>
          {previewProduct && (
            // 预览不产生交互：私信链接禁用，购买按钮为空操作
            <div className="[&_a]:pointer-events-none">
              <ProductCard
                product={previewProduct}
                balance={Number.MAX_SAFE_INTEGER}
                sellerName={previewProduct.ownerName}
                onBuy={() => {}}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 用户商品可选的交付方式（与 pointshop-shared 的 USER_DELIVERY_OPTIONS 同一口径） */
const SHOP_USER_DELIVERY_OPTIONS = ["manual", "code", "content"] as const

/** 租期快捷值（天） */
const RENTAL_PRESETS = [7, 30, 90, 365] as const
