import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Lock } from "lucide-react"
import { toast } from "sonner"

import { authApi, twoFactorApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * 管理后台**自带**的登录页（2026-10-25 后台独立认证）。
 *
 * 与主站 /login 的关系：走的是同一套 /api/login（含 2FA 挑战），但界面与流程
 * 完全收在管理 SPA 里 —— 后台的登录体验、后续加固（独立会话策略、验证码、
 * IP 限制）都不再牵动用户站。复用 authApi/twoFactorApi 保证与主站登录
 * 的状态机逐字节一致（2FA 挑战、账号封禁提示等），不做第二份实现。
 */
export default function AdminLogin() {
  const { t } = useT()
  const navigate = useNavigate()
  const { setUser } = useAuth()
  const [identifier, setIdentifier] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  /** 2FA 挑战（口令已过、还差一道验证码时进入这个状态） */
  const [challenge, setChallenge] = React.useState<{
    id: string
    methods: string[]
    maskedEmail: string
  } | null>(null)
  const [method, setMethod] = React.useState("")
  const [code, setCode] = React.useState("")
  const [codeSent, setCodeSent] = React.useState(false)
  const [sendingCode, setSendingCode] = React.useState(false)

  /** 登录成功后的收尾：写入全局登录态并回后台首页 */
  const finishLogin = async (user: NonNullable<Awaited<ReturnType<typeof authApi.login>>["user"]>) => {
    if (user.role !== "admin" && user.role !== "superadmin" && user.role !== "root") {
      // 口令正确但不是管理员：明确说出来，别让人在后台反复试密码
      setError(t("adm.login.notAdmin"))
      return
    }
    setUser(user)
    toast.success(t("adm.login.ok"))
    navigate("/admin/users", { replace: true })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.login({ identifier, password })
      if (res.needTwoFactor && res.challengeId) {
        const methods = res.methods ?? []
        setChallenge({ id: res.challengeId, methods, maskedEmail: res.maskedEmail ?? "" })
        setMethod(methods[0] ?? "")
        setCode("")
        setCodeSent(false)
        return
      }
      await finishLogin(res.user!)
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t("adm.login.failed"))
    } finally {
      setLoading(false)
    }
  }

  const sendEmailCode = async () => {
    if (!challenge) return
    setSendingCode(true)
    try {
      await twoFactorApi.sendLoginEmail(challenge.id)
      setCodeSent(true)
      toast.success(t("adm.login.codeSent"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.login.codeSendFailed"))
    } finally {
      setSendingCode(false)
    }
  }

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setLoading(true)
    try {
      const res = await twoFactorApi.verifyLogin({
        challengeId: challenge.id,
        method,
        code: code.trim(),
      })
      await finishLogin(res.user)
    } catch (err) {
      if (err instanceof HttpError && err.code === "CHALLENGE_EXPIRED") {
        setChallenge(null)
        setCode("")
        setError(t("adm.login.challengeExpired"))
      } else {
        setError(err instanceof HttpError ? err.message : t("adm.login.verifyFailed"))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <Lock className="mx-auto h-6 w-6 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("adm.login.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("adm.login.subtitle")}</p>
        </div>

        {!challenge ? (
          <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-6">
            <div className="space-y-2">
              <Label htmlFor="admin-identifier">{t("adm.login.identifier")}</Label>
              <Input
                id="admin-identifier"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-password">{t("adm.login.password")}</Label>
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !identifier || !password}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.login.submit")}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4 rounded-lg border bg-card p-6">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("adm.login.2faTitle")}</p>
              {method === "email" && (
                <p className="text-xs text-muted-foreground">
                  {t("adm.login.2faEmailHint", { v0: challenge.maskedEmail })}
                </p>
              )}
            </div>

            {challenge.methods.length > 1 && (
              <div className="flex gap-2">
                {challenge.methods.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={method === m ? "default" : "outline"}
                    onClick={() => {
                      setMethod(m)
                      setCodeSent(false)
                    }}
                  >
                    {t(`adm.login.method.${m}`)}
                  </Button>
                ))}
              </div>
            )}

            {method === "email" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void sendEmailCode()}
                disabled={sendingCode || codeSent}
                className="w-full"
              >
                {sendingCode && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {codeSent ? t("adm.login.codeSentBtn") : t("adm.login.sendCode")}
              </Button>
            )}

            <div className="space-y-2">
              <Label htmlFor="admin-2fa-code">{t("adm.login.code")}</Label>
              <Input
                id="admin-2fa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !code.trim()}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.login.verify")}
            </Button>
          </form>
        )}

        <p className="text-center text-xs text-muted-foreground">
          <a href="/" className="hover:underline">
            {t("adm.login.backHome")}
          </a>
        </p>
      </div>
    </div>
  )
}
