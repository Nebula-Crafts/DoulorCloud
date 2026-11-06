/**
 * 管理端「监管 → 举报」面板（2026-11-06）。
 *
 * 用户对别人的帖子 / 评论发起举报后进入这里。两条操作：
 *   · 忽略 —— 内容保留，举报关闭（记审计）
 *   · 下架 —— 软删内容（与管理员手动删帖同一套语义，数据上无法区分）
 *
 * 列表默认只看待处理，可切「全部」回看历史处理结果。
 */
import * as React from "react"
import { CheckCircle2, Flag, Loader2, RefreshCw, ShieldOff, Trash2, XCircle } from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { adminReportApi, HttpError, errMsg } from "@/services/api"
import { fmtTime, relTime } from "@/lib/format"
import { useT } from "@/i18n"
import type { ReportItem } from "@/types"
import { notifyAttentionChanged } from "@/lib/attention-events"

/** 原因 → 文案 key */
const REASON_KEY: Record<string, string> = {
  spam: "report.reason.spam",
  abuse: "report.reason.abuse",
  illegal: "report.reason.illegal",
  copyright: "report.reason.copyright",
  other: "report.reason.other",
}

export function ReportsAdminPanel() {
  const { t } = useT()
  const [status, setStatus] = React.useState<"pending" | "all">("pending")
  const [items, setItems] = React.useState<ReportItem[] | null>(null)
  const [pending, setPending] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminReportApi.list(status)
      setItems(res.reports)
      setPending(res.pending)
    } catch (err) {
      toast.error(errMsg(err, t("report.admin.loadFailed")))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [status, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const decide = async (item: ReportItem, action: "ignore" | "remove") => {
    if (busyId) return
    setBusyId(item.id)
    try {
      await adminReportApi.decide(item.id, action)
      toast.success(action === "remove" ? t("report.admin.removed") : t("report.admin.ignored"))
      // 侧边栏「管理」角标当场减一，不用等 60 秒轮询
      notifyAttentionChanged()
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : errMsg(err, t("report.admin.fail")))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={status === "pending" ? "default" : "outline"}
          onClick={() => setStatus("pending")}
        >
          {t("report.admin.pendingTab")}
          {pending > 0 && (
            <Badge variant="destructive" className="ml-1.5 h-4 px-1 text-[10px] tabular-nums">
              {pending}
            </Badge>
          )}
        </Button>
        <Button
          size="sm"
          variant={status === "all" ? "default" : "outline"}
          onClick={() => setStatus("all")}
        >
          {t("report.admin.allTab")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {t("mod.refresh")}
        </Button>
      </div>

      {loading && !items ? (
        <LoadingBlock variant="list" />
      ) : !items || items.length === 0 ? (
        <EmptyState
          icon={Flag}
          title={status === "pending" ? t("report.admin.empty") : t("report.admin.emptyAll")}
          description={t("report.admin.emptyDesc")}
        />
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {r.targetType === "post" ? t("report.admin.post") : t("report.admin.comment")}
                  </Badge>
                  <Badge variant="destructive" className="text-[10px]">
                    {t(REASON_KEY[r.reason] ?? r.reason)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("report.admin.by", {
                      reporter: r.reporterName ?? r.reporterId.slice(0, 8),
                      author: r.authorName ?? r.authorId?.slice(0, 8) ?? "?",
                    })}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground" title={fmtTime(r.createdAt)}>
                    {relTime(r.createdAt)}
                  </span>
                </div>

                {/* 内容摘要：内容已删时说明白，避免管理员以为「怎么是空的」 */}
                {r.targetDeleted ? (
                  <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    {t("report.admin.targetDeleted")}
                  </p>
                ) : (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    {r.excerpt || t("report.admin.noExcerpt")}
                  </p>
                )}

                {r.note && (
                  <p className="text-xs text-muted-foreground">
                    {t("report.admin.note", { note: r.note })}
                  </p>
                )}

                {r.status === "pending" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r, "remove")}
                    >
                      {busyId === r.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {t("report.admin.remove")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r, "ignore")}
                    >
                      <XCircle className="mr-1.5 h-3.5 w-3.5" />
                      {t("report.admin.ignore")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {r.status === "removed" ? (
                      <>
                        <ShieldOff className="h-3.5 w-3.5 text-destructive" />
                        {t("report.admin.statusRemoved", { time: fmtTime(r.handledAt) })}
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        {t("report.admin.statusIgnored", { time: fmtTime(r.handledAt) })}
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
