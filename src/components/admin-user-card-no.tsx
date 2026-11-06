import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"
import type { AdminCardNumber } from "@/types"

/**
 * 给单个用户发放 / 清除「会员银行卡号」（2026-11-06）。
 *
 * 两个入口合一：
 *   * 手填 —— 15 位会自动补 Luhn 校验位，16 位必须是合法卡号（后端校验）；
 *   * 从靓号池点选 —— 池子里预留的号不会被自动分配，只能在这里发出去。
 *
 * 清空（传 null）后，用户下次打开积分页或再次升级会重新生成一个随机号。
 */
export function AdminUserCardNoDialog({
  open,
  onOpenChange,
  username,
  cardNo,
  memberLevel,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  username: string
  /** 当前卡号（null = 未分配） */
  cardNo: string | null
  /** 会员等级：< 1 时卡面不显示卡号，但依然可以先预分配 */
  memberLevel: number
  /** 保存成功后刷新父级用户详情 */
  onSaved: () => void
}) {
  const { t } = useT()
  const [draft, setDraft] = React.useState("")
  const [pool, setPool] = React.useState<AdminCardNumber[]>([])
  const [loadingPool, setLoadingPool] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setDraft("")
    setLoadingPool(true)
    void adminApi
      .listCardNumbers()
      .then((res) => setPool(res.items.filter((i) => i.status === "reserved")))
      .catch(() => setPool([]))
      .finally(() => setLoadingPool(false))
  }, [open])

  const save = async (value: string | null) => {
    setBusy(true)
    try {
      const res = await adminApi.setUserCardNo(username, value)
      toast.success(value === null ? t("adm.card.cleared") : t("adm.card.saved"))
      if (res.cardNo === null && memberLevel >= 1) {
        // 清空后不会立刻有新号：下一次读积分概览时才补发，提醒一句避免误会
        toast.info(t("adm.card.regenerateHint"))
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.card.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("adm.card.userTitle")}</DialogTitle>
          <DialogDescription>
            {t("adm.card.userDesc", { v0: username, v1: t(`lvl.${memberLevel}`) })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground">{t("adm.card.current")}</p>
              <p className="font-mono text-sm tabular-nums">
                {cardNo ? cardNo.replace(/(\d{4})(?=\d)/g, "$1 ") : t("adm.card.none")}
              </p>
            </div>
            {cardNo && (
              <Badge variant="outline">{t("adm.card.hasCard")}</Badge>
            )}
          </div>

          {memberLevel < 1 && (
            <p className="text-xs text-amber-600">{t("adm.card.belowLevel")}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="cardNoInput">{t("adm.card.issueLabel")}</Label>
            <Input
              id="cardNoInput"
              className="font-mono"
              placeholder={t("adm.card.issuePlaceholder")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("adm.card.issueHint")}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("adm.card.pickFromPool")}</Label>
              <span className="text-xs text-muted-foreground">
                {t("adm.card.poolCount", { n: pool.length })}
              </span>
            </div>
            {loadingPool ? (
              <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : pool.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("adm.card.poolEmpty")}</p>
            ) : (
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2">
                {pool.map((item) => (
                  <button
                    key={item.number}
                    type="button"
                    onClick={() => setDraft(item.formatted)}
                    className="rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition hover:bg-accent"
                  >
                    {item.formatted}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          {cardNo && (
            <Button variant="outline" disabled={busy} onClick={() => void save(null)}>
              {t("adm.card.clear")}
            </Button>
          )}
          <Button disabled={busy || !draft.trim()} onClick={() => void save(draft.trim())}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("adm.card.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}