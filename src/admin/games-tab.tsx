import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { InvestGamePanel } from "@/admin/game-invest-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/i18n"
import { adminCollectionApi, collectionApi, errMsg, type CollectionPlugin } from "@/services/api"
import { cn } from "@/lib/utils"

/**
 * 管理后台 ·「游戏仓库」tab（2026-10-25 模拟人生改造）。
 *
 * 单 tab + 游戏子导航：左列是全部游戏（含已下架，来自
 * `GET /api/collection/plugins` 的管理员口径），每行一个**上架/下架开关**
 * （`PUT /api/admin/collection/plugins/:slug`，对所有游戏通用——这就是热插拔总闸）；
 * 右列是选中游戏的设置面板：`invest` 有专属面板（玩法参数 / 做市池 / 统计 /
 * 危险操作，自创想设置迁入），其余游戏给通用字段编辑。
 *
 * 可见性由 AdminPage 的 `canSeeTab("collection")` 把关（本 tab 的全部接口都在
 * `collection` 权限域下）。
 */
export default function GamesTab() {
  const { t } = useT()
  const [plugins, setPlugins] = React.useState<CollectionPlugin[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [selected, setSelected] = React.useState<string>("")
  const [toggling, setToggling] = React.useState<string>("")

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await collectionApi.plugins()
      setPlugins(res.plugins ?? [])
      setSelected((cur) => {
        if (cur && (res.plugins ?? []).some((p) => p.slug === cur)) return cur
        return res.plugins?.[0]?.slug ?? ""
      })
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 上架/下架总闸：对所有游戏通用 */
  const toggleStatus = async (p: CollectionPlugin) => {
    const next = p.status === "published" ? "disabled" : "published"
    setToggling(p.slug)
    try {
      const res = await adminCollectionApi.updatePlugin(p.slug, { status: next })
      setPlugins((prev) => prev.map((x) => (x.slug === p.slug ? { ...x, status: res.plugin.status } : x)))
      toast.success(
        next === "published" ? t("adm.games.published") : t("adm.games.disabled")
      )
    } catch (err) {
      toast.error(errMsg(err, t("col.loadFailed")))
    } finally {
      setToggling("")
    }
  }

  const selectedPlugin = plugins.find((p) => p.slug === selected) ?? null

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">{t("adm.games.desc")}</p>

      {loading ? (
        <div className="flex min-h-[200px] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : failed ? (
        <p className="text-sm text-destructive">{t("col.loadFailed")}</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("col.empty")}</p>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左列：游戏清单（含已下架）+ 热插拔开关 */}
          <aside className="w-full shrink-0 space-y-2 lg:w-64">
            {plugins.map((p) => (
              <div
                key={p.slug}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-3 transition-colors",
                  selected === p.slug ? "border-foreground/30 bg-accent/50" : "bg-card"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setSelected(p.slug)}
                >
                  <span className="text-xl leading-none">{p.icon || "🎮"}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{p.slug}</span>
                  </span>
                </button>
                <Badge variant={p.status === "published" ? "default" : "outline"}>
                  {t(`cs.status.${p.status}`)}
                </Badge>
                <Switch
                  checked={p.status === "published"}
                  disabled={toggling === p.slug}
                  onCheckedChange={() => void toggleStatus(p)}
                  aria-label={t("adm.games.toggle")}
                />
              </div>
            ))}
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("adm.games.hint")}
            </p>
          </aside>

          {/* 右列：选中游戏的设置面板 */}
          <div className="min-w-0 flex-1">
            {selectedPlugin ? (
              selectedPlugin.slug === "invest" ? (
                <InvestGamePanel />
              ) : (
                <GenericPluginPanel
                  plugin={selectedPlugin}
                  onSaved={(updated) =>
                    setPlugins((prev) => prev.map((x) => (x.slug === updated.slug ? updated : x)))
                  }
                />
              )
            ) : (
              <p className="text-sm text-muted-foreground">{t("adm.games.pickOne")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 无专属面板的游戏：通用字段编辑（未来 sandbox 用户游戏也用这份） */
function GenericPluginPanel({
  plugin,
  onSaved,
}: {
  plugin: CollectionPlugin
  onSaved: (updated: CollectionPlugin) => void
}) {
  const { t } = useT()
  const [name, setName] = React.useState(plugin.name)
  const [icon, setIcon] = React.useState(plugin.icon)
  const [tagline, setTagline] = React.useState(plugin.tagline)
  const [description, setDescription] = React.useState(plugin.description)
  const [saving, setSaving] = React.useState(false)

  // 切换选中游戏时同步表单
  React.useEffect(() => {
    setName(plugin.name)
    setIcon(plugin.icon)
    setTagline(plugin.tagline)
    setDescription(plugin.description)
  }, [plugin])

  const save = async () => {
    setSaving(true)
    try {
      const res = await adminCollectionApi.updatePlugin(plugin.slug, {
        name,
        icon,
        tagline,
        description,
      })
      onSaved(res.plugin)
      toast.success(t("adm.games.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("col.loadFailed")))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="space-y-2">
        <Label>{t("adm.games.fieldName")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </div>
      <div className="space-y-2">
        <Label>{t("adm.games.fieldIcon")}</Label>
        <Input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} className="w-24" />
      </div>
      <div className="space-y-2">
        <Label>{t("adm.games.fieldTagline")}</Label>
        <Input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={80} />
      </div>
      <div className="space-y-2">
        <Label>{t("adm.games.fieldDesc")}</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
      </div>
      <Button onClick={() => void save()} disabled={saving || !name.trim()}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {t("common.save")}
      </Button>
    </div>
  )
}
