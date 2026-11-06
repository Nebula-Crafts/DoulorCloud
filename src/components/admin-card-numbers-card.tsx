import * as React from "react"
import { CreditCard, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { adminApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"
import type { AdminCardNumber } from "@/types"

/**
 * 后台「银行卡靓号池」（2026-11-06 站长要求）。
 *
 * 池子里的号自动生成永远不会命中，只能由管理员指定发放给某个用户
 * （发放入口在「用户详情 → 会员银行卡号」里）。
 * 数据自取自管，不往 AdminPage 那个巨型组件里再塞 state。
 */
export function AdminCardNumbersCard() {
  const { t } = useT()
  const [items, setItems] = React.useState<AdminCardNumber[]>([])
  const [loading, setLoading] = React.useState(true)
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.listCardNumbers()
      setItems(res.items)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.card.loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleAdd = async () => {
    const numbers = draft.split(/[\n,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
    if (numbers.length === 0) return
    setBusy(true)
    try {
      const res = await adminApi.reserveCardNumbers(numbers)
      if (res.added.length > 0) toast.success(t("adm.card.added", { n: res.added.length }))
      // 跳过的逐个提示原因（校验位不对 / 已在池中 / 已被某人持有）
      for (const s of res.skipped) toast.warning(`${s.number}：${s.reason}`)
      setDraft("")
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.card.addFailed"))
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (item: AdminCardNumber) => {
    if (!confirm(t("adm.card.removeConfirm", { v0: item.formatted }))) return
    setBusy(true)
    try {
      await adminApi.deleteCardNumber(item.number)
      toast.success(t("adm.card.removed"))
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.card.removeFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="h-4 w-4" />
          {t("adm.card.title")}
        </CardTitle>
        <CardDescription>{t("adm.card.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            rows={3}
            className="font-mono text-xs"
            placeholder={t("adm.card.placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void handleAdd()} disabled={busy || !draft.trim()}>
              {busy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("adm.card.add")}
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("adm.card.empty")}</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adm.card.number")}</TableHead>
                  <TableHead className="w-24">{t("adm.card.status")}</TableHead>
                  <TableHead>{t("adm.card.holder")}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.number}>
                    <TableCell className="font-mono text-sm tabular-nums">{item.formatted}</TableCell>
                    <TableCell>
                      <Badge variant={item.status === "issued" ? "secondary" : "outline"}>
                        {item.status === "issued" ? t("adm.card.issued") : t("adm.card.reserved")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {item.username ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || item.status === "issued"}
                        title={
                          item.status === "issued" ? t("adm.card.cannotRemoveIssued") : undefined
                        }
                        onClick={() => void handleRemove(item)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}