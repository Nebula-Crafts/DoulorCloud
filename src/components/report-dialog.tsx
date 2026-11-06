/**
 * 社区举报弹窗（2026-11-06）。
 *
 * 帖子卡片与评论都复用它：选一个原因（必填）+ 可选补充说明，提交后关窗。
 * 后端对同一目标只接受一条待处理举报，重复提交会返回 409 —— 这里把那条
 * 错误原样弹给用户（「你已经举报过这条内容」），不做本地去重缓存：
 * 举报状态在服务端，前端缓存反而会出现「刷新后按钮还亮着」的错位。
 */
import * as React from "react"
import { Flag, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { communityApi, errMsg, HttpError } from "@/services/api"
import { useT } from "@/i18n"
import type { ReportReason } from "@/types"

/** 举报原因选项（与后端 REPORT_REASONS 一一对应，顺序即展示顺序） */
const REASON_OPTIONS: { value: ReportReason; labelKey: string }[] = [
  { value: "spam", labelKey: "report.reason.spam" },
  { value: "abuse", labelKey: "report.reason.abuse" },
  { value: "illegal", labelKey: "report.reason.illegal" },
  { value: "copyright", labelKey: "report.reason.copyright" },
  { value: "other", labelKey: "report.reason.other" },
]

export function ReportDialog({
  open,
  onOpenChange,
  targetType,
  targetId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  targetType: "post" | "comment"
  targetId: string
}) {
  const { t } = useT()
  const [reason, setReason] = React.useState<ReportReason>("spam")
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  // 每次打开都重置，避免上一条的说明串到这一条
  React.useEffect(() => {
    if (open) {
      setReason("spam")
      setNote("")
    }
  }, [open])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await communityApi.report({
        targetType,
        targetId,
        reason,
        note: note.trim() || undefined,
      })
      toast.success(t("report.ok"))
      // ⚠️ 必须先解除 busy 再关窗：Dialog 的 onOpenChange 带 `!busy &&` 守卫，
      //    此刻 busy 还是 true 的话这次关闭会被静默吞掉（弹窗留在原地）。
      setBusy(false)
      onOpenChange(false)
    } catch (err) {
      // 已举报过 / 内容已删 都用后端文案，前端不重复判断
      toast.error(err instanceof HttpError ? err.message : errMsg(err, t("report.fail")))
      // 这两种情况再留着弹窗也没意义（一条已经在了 / 内容都没了），直接关
      if (
        err instanceof HttpError &&
        (err.code === "ALREADY_DELETED" || err.code === "ALREADY_REPORTED")
      ) {
        setBusy(false)
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-destructive" aria-hidden="true" />
            {t("report.title")}
          </DialogTitle>
          <DialogDescription>
            {targetType === "post" ? t("report.descPost") : t("report.descComment")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t("report.reasonLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              {REASON_OPTIONS.map((o) => (
                <Button
                  key={o.value}
                  type="button"
                  size="sm"
                  variant={reason === o.value ? "default" : "outline"}
                  onClick={() => setReason(o.value)}
                >
                  {t(o.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="report-note">{t("report.noteLabel")}</Label>
            <Textarea
              id="report-note"
              rows={3}
              maxLength={300}
              placeholder={t("report.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("report.hint")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t("report.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
