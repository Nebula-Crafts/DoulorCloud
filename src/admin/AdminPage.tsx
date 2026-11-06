import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  Ticket,
  Pencil,
  Plus,
  ImagePlus,
  Megaphone,
  RefreshCw,
  Search,
  ShieldBan,
  ShieldAlert,
  ShieldCheck,
  Medal,
  SlidersHorizontal,
  Network,
  Check,
  Link2,
  Trash2,
  UserCheck,
  Users,
  MessagesSquare,
  MessageSquare,
  RotateCcw,
  X,
  BarChart3,
  Gauge,
  ArrowLeft,
  ExternalLink,
  PartyPopper,
  Clock,
  ScrollText,
  Coins,
  Eye,
  EyeOff,
  Activity,
} from "lucide-react"
import { toast } from "sonner"

// OAuth 应用的 UI 本体单独放一个文件，避免继续撑大本文件
// （本文件已 4500+ 行，且可能有其他改动同时在动它）。
import { OAuthAdminPanel } from "@/pages/admin-oauth"
import { AnalyticsPanel } from "@/pages/admin-analytics"
import { CfQuotaPanel } from "@/pages/admin-cf-quota"
// 反馈面板同理单独成文件（本文件太大，新增内容尽量外置）
import { FeedbackPanel } from "@/pages/admin-feedback"
// 性能监控（2026-10-10 新工具）：UI 本体单独成文件
import { PerfPanel } from "@/pages/admin-perf"
import { AuditPanel } from "@/pages/admin-audit"
import { PointsAdminPanel } from "@/pages/admin-points"
import { TitlesAdminPanel } from "@/pages/admin-titles"
import { ModerationAdminPanel } from "@/pages/admin-moderation"
import { AdminNoticesPanel } from "@/pages/admin-notices"
// DNS 解析管理（全站记录 / 合规扫描 / 与 Cloudflare 对账）同理外置

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { NavItem, NavGroup } from "@/components/sub-nav"
import { SectionedCards } from "@/components/sectioned-cards"
import { SlidingPill } from "@/components/motion/sliding-pill"
import { AdminPermissionsPanel } from "@/components/admin-permissions"
import { AdminCardNumbersCard } from "@/components/admin-card-numbers-card"
import { AdminUserCardNoDialog } from "@/components/admin-user-card-no"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { LoadingBlock } from "@/components/loading-block"
import { AdminInvitesSkeleton, AdminUsersSkeleton } from "@/components/skeletons"
// 投票规则的判断 / 文案映射与用户端共用一份 —— 两处各写一遍迟早会出现
// 「后台显示多数得奖、用户端显示少数得奖」这种自相矛盾
import { QuizEditor } from "@/components/quiz-editor"
import { isInstantVoteRule, VOTE_RULE_LABEL_KEY } from "@/components/event-vote"
import { Button } from "@/components/ui/button"
import { confirmDialog } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tabs,
  TabsContent,
} from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  adminApi,
  twoFactorApi,
  announcementApi,
  adminEventApi,
  attentionApi,
  HttpError,
} from "@/services/api"
import { useT } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"

/**
 * 可授权的功能模块。
 *
 * 2026-11-06 大裁撤后站点只剩「社区 + 积分商城 + OAuth」，没有任何模块再按用户授权，
 * 所以这张表**刻意留空** —— 邀请码权限、成员详情里的模块权限开关都不再渲染。
 * 后端的 `FEATURES` 与 `users.permissions` 列保留，将来加新模块时在这里补一行即可。
 */
const FEATURES: { key: FeatureKey; label: string; desc: string }[] = []



import type {
  AdminInviteQuotasResponse,
  AdminUserInviteQuotaResponse,
  FeatureCounts,
  Announcement,
  AnnouncementStatus,
  EventItem,
  EventClaim,
  EventPayload,
  EventStatus,
  EventRewardType,
  EventConditionType,
  EventVoteRewardRule,
  AdminInvite,
  AdminUser,
  AdminUserDetail,
  FeatureKey,
  MailMessage,
  Permissions,
  AdminCommunityPost,
  RecommendedTier,
  AttentionCounts,
  AdminPermCategory,
  PostCategoryDef,
  AdminInviteTrace,
  AuditLog,
} from "@/types"
import { FEATURE_LABELS } from "@/types"
import { fmtUid } from "@/lib/format"
import { onAttentionChanged, notifyAttentionChanged } from "@/lib/attention-events"

/** 与 Worker 端 settings.ts 的 formatBytes 保持一致 */
/**
 * 解析后端的布尔设置项。
 *
 * ⚠️ 2026-09-26 发现的问题：后端 `updateSettings` 会做 `String(value)`，
 * 而前端保存时传的是 JS 布尔 ⇒ **管理员改过一次之后，库里存的就是
 * "true"/"false"**（不再是最初的 "1"/"0"）。后端 `getSettingBool` 两种都认，
 * 但前端原先一律写 `=== "1"`，于是：
 *   · 任何开关「关 → 开」操作后再刷新，开关会显示成「关闭」（功能其实是开的）；
 *   · `community_guest_access` 原先用 `!== "0"` 判断，存了 "false" 时会显示
 *     「允许访客」—— 与后端实际值**完全相反**。
 * 所以读取必须同时认 "1" 与 "true"（大小写不敏感）。fallback 取后端默认值。
 */
function isSettingOn(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback
  return raw === "1" || raw.toLowerCase() === "true"
}

/**
 * 解析设置里的 `post_categories`（JSON 数组）。
 *
 * 前端**只做宽松解析、不做合法性校验** —— 校验是后端 `parsePostCategories` 的职责。
 * 这里再实现一套规则迟早与后端走偏，而不一致时"该信谁"没有答案。
 * 所以坏值原样带出来给管理员看/改，保存时由后端决定丢弃还是拒绝。
 */
function parseCategorySetting(raw: string | undefined): PostCategoryDef[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((o) => ({
        key: String(o.key ?? ""),
        zh: String(o.zh ?? ""),
        en: String(o.en ?? ""),
        ...(o.water === true ? { water: true } : {}),
      }))
  } catch {
    return []
  }
}

/** 与 parseCategorySetting 对称地写回设置值（后端保存时还会再校验一遍） */
function serializeCategories(list: PostCategoryDef[]): string {
  const out: PostCategoryDef[] = []
  for (const c of list) {
    const key = c.key.trim().toLowerCase()
    const zh = c.zh.trim()
    const en = c.en.trim()
    // 整行都空 = 管理员加了一行但没填，跳过（别往设置里写空分类）
    if (!key && !zh && !en) continue
    out.push({
      key,
      // 只有一个名字时用另一个补上：后端要求「至少一个名字」。
      // 前端先补好，免得管理员只填了中文就保存失败、还不知道为什么。
      zh: zh || en,
      en: en || zh,
      // ⚠️ water 标记**必须原样带回去** —— 漏了它「不看水帖」就静默失效
      ...(c.water ? { water: true } : {}),
    })
  }
  return JSON.stringify(out)
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}


// ---- 活动表单 ----

interface EventDraft {
  id: string | null
  title: string
  body: string
  status: EventStatus
  /** datetime-local 的值（本地时区，形如 2026-09-27T10:00） */
  startsAt: string
  endsAt: string
  rewardLabel: string
  rewardType: EventRewardType
  /** 奖励数量：newapi_quota 用 amount（元），invite_quota 用 count，points 用 amount（积分数） */
  rewardAmount: string
  /**
   * 积分奖励是否走「区间随机」（仅 rewardType = points 时有意义）。
   * 勾上后改用 rewardMin / rewardMax 两个输入框，发放时在闭区间内取一个整数。
   */
  pointsRandom: boolean
  /** 区间下限（积分数） */
  rewardMin: string
  /** 区间上限（积分数） */
  rewardMax: string
  conditionType: EventConditionType
  conditionFeature: string
  /** 认证码（conditionType = code 时用）：用户凭它领取，通常公布在 QQ 群等站外 */
  conditionCode: string
  /** 要核验 star 的 GitHub 仓库（conditionType = github_star 时用），形如 owner/repo */
  conditionRepo: string
  /** 抽奖（conditionType = lottery 时用）：中奖人数 */
  lotteryWinners: string
  /** 抽奖：奖池总积分（中奖者共享） */
  lotteryPool: string
  /** 抽奖：分配方式（平均分 / 随机分） */
  lotteryMode: "even" | "random"
  /**
   * 投票（conditionType = vote）的选项。
   * ⚠️ 每一项都带一个稳定的 `key`（= 提交时的选项 id），用于 React 列表与
   * 「改标题不影响已投出的票」—— 选项 id 一旦生成就不随标题变化。
   */
  voteOptions: { key: string; label: string; desc: string; image: string }[]
  /**
   * 投票形态：普通投票（选一个选项）还是**问卷**（多题、按答对率发奖）。
   * 问卷配置直接粘 JSON —— 结构比普通投票深一层，结构化表单是后续的事。
   */
  quizMode: boolean
  /** 问卷 JSON（与后端 parseQuizConfig 的形状一致，见 worker/src/event-rewards.ts） */
  quizJson: string
  /** 投票：获奖规则（七档，见 EventVoteRewardRule） */
  voteRule: EventVoteRewardRule
  /**
   * 「固定选项获奖」指定的那个选项（草稿里存的是选项的 key）。
   * 仅在 voteRule 是 fixed / instant_fixed 时有意义。
   */
  voteFixedOptionId: string
  /**
   * true = 不在消息中心「活动推广」里显示、也不广播通知，只能通过链接参与。
   */
  promoHidden: boolean
  /** 限量总份数：留空 = 不限量；先到先得，领满即止。抽奖时是「参与人数上限」 */
  maxClaims: string
  /** 定时上线时间（datetime-local）；status=scheduled 时用 */
  publishAt: string
}

function emptyEventDraft(): EventDraft {
  return {
    id: null,
    title: "",
    body: "",
    status: "draft",
    startsAt: "",
    endsAt: "",
    rewardLabel: "",
    rewardType: "none",
    rewardAmount: "",
    pointsRandom: false,
    rewardMin: "",
    rewardMax: "",
    conditionType: "always",
    conditionFeature: "ai",
    conditionCode: "",
    conditionRepo: "Doulor/DoulorCloud",
    lotteryWinners: "10",
    lotteryPool: "1000",
    lotteryMode: "even",
    // 默认给两个空选项：投票至少要有 2 个（后端也会拒少于 2 个的配置），
    // 默认就摆两行能省掉「点新建再加一行」这一步
    quizMode: false,
    quizJson: "",
    voteOptions: [
      { key: newOptionKey(), label: "", desc: "", image: "" },
      { key: newOptionKey(), label: "", desc: "", image: "" },
    ],
    voteRule: "all",
    voteFixedOptionId: "",
    promoHidden: false,
    maxClaims: "",
    publishAt: "",
  }
}

/**
 * 生成投票选项的稳定 id。
 *
 * 为什么不用数组下标：选项的 id 会随投票一起落库，中途删掉中间一项会让
 * 后面所有选项的 id 整体前移，已经投出去的票就对到别的选项上了（计数直接错）。
 * 用随机串 + 编辑时保持不动，才谈得上「选项改了标题，票还在它名下」。
 */
function newOptionKey(): string {
  return `o${Math.random().toString(36).slice(2, 10)}`
}

/** 合法的投票获奖规则（与后端 VOTE_REWARD_RULES 一一对应） */
const VOTE_RULE_VALUES: readonly EventVoteRewardRule[] = [
  "all",
  "instant_fixed",
  "instant_majority",
  "instant_minority",
  "fixed",
  "majority",
  "minority",
]

/** 「指定选项获奖」的两档：需要额外选一个获奖选项 */
function isFixedVoteRule(r: EventVoteRewardRule): boolean {
  return r === "fixed" || r === "instant_fixed"
}

/**
 * 解析投票获奖规则（认不出来的值一律当「参与即可获奖」）。
 * 用显式列表而不是 `as` 断言 —— 断言会把任意非法字符串当合法值交给后端（保存时才失败），
 * 这里回落成 all 至少是可见的、不会静默丢配置。
 */
function parseVoteRule(v: unknown): EventVoteRewardRule {
  return typeof v === "string" && (VOTE_RULE_VALUES as readonly string[]).includes(v)
    ? (v as EventVoteRewardRule)
    : "all"
}

/**
 * 这条投票规则是不是「要等截止后开奖」才出结果。
 *
 * 用来决定列表里显不显示「开奖」按钮、徽章标不标「待开奖」：
 * `all`（参与即可获奖）与三条 `instant_*`（投票后立刻结算）在投票那一刻就结算完了，
 * 给它们显示开奖按钮等于引导站长去点一个必然报错的操作（后端会拒）。
 */
function needsDrawForVote(rule: EventVoteRewardRule): boolean {
  return rule === "fixed" || rule === "majority" || rule === "minority"
}

/**
 * 投票活动的**总票数**（= 已投票人数）。
 *
 * ⚠️ 不能用 `claimCount` 代替：开奖前还没有人产生领取记录，claimCount 恒为 0，
 * 拿它当「参与人数」会在开奖确认框里显示「当前 0 人投票」（2026-10-07 修）。
 * 票数只有**管理端**接口才恒下发 —— 用户端在「未投票且未开奖」时拿到的是空对象
 * （后端 voteCountsVisible 收口，防止控制台偷看实时票数照着投）。
 */
function voteTotal(ev: EventItem): number {
  return Object.values(ev.voteCounts ?? {}).reduce((a, b) => a + b, 0)
}

/**
 * 把活动和库里的投票配置还原成表单草稿。
 *
 * ⚠️ 必须**保留原选项 id**：编辑活动时若重新生成 id，已经投出去的票就会指向
 * 一个不存在的选项 —— 开奖时按「现存选项」过滤，那批票会被静默丢掉（用户
 * 明明投了却显示未参与）。id 只在新建选项时才生成。
 *
 * 少于 2 项时补空行：投票至少要有 2 个选项，否则表单连合法配置都编不出来。
 */
function voteOptionsFromParams(
  params: Record<string, unknown> | null | undefined
): EventDraft["voteOptions"] {
  const raw = params?.options
  const list = Array.isArray(raw) ? raw : []
  const mapped: EventDraft["voteOptions"] = []
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>
    const label = typeof o.label === "string" ? o.label : ""
    const id = typeof o.id === "string" && o.id ? o.id : ""
    if (!label && !id) continue
    mapped.push({
      key: id || newOptionKey(),
      label,
      desc: typeof o.desc === "string" ? o.desc : "",
      image: typeof o.image === "string" ? o.image : "",
    })
  }
  while (mapped.length < 2) {
    mapped.push({ key: newOptionKey(), label: "", desc: "", image: "" })
  }
  return mapped
}

/** ISO → datetime-local 输入框的值（本地时区） */
function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 值 → ISO（空串 → null，交由后端当「不限」处理） */
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function eventDraftToPayload(d: EventDraft): EventPayload {
  const amount = Number(d.rewardAmount)
  /** 抽奖活动：奖励固定是积分，奖池在 conditionParams.pool 里，不走 rewardParams */
  const isLottery = d.conditionType === "lottery"
  const rewardParams = isLottery
    ? null
    : d.rewardType === "newapi_quota"
      ? { amount: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1 }
      : d.rewardType === "invite_quota"
        ? { count: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 2 }
        : d.rewardType === "points"
          ? d.pointsRandom
            ? (() => {
                // 区间随机：**允许负数**（扣积分），也允许跨越 0。
                // 只做「空/非数字 → 回落」的兜底，具体合法性（上限不小于下限、
                // 绝对值上限）交给后端 validatePointsReward 统一判 —— 两边各写一套
                // 迟早出现「前端放过、后端拒绝」的不一致。
                const num = (raw: string, fallback: number) =>
                  raw.trim() !== "" && Number.isFinite(Number(raw))
                    ? Math.trunc(Number(raw))
                    : fallback
                const lo = num(d.rewardMin, 1)
                const hi = num(d.rewardMax, lo)
                return { min: lo, max: Math.max(lo, hi) }
              })()
            : {
                // 固定值：允许负数（扣积分）；空/非数字 → 回落 10（与旧行为一致）
                amount: (() => {
                  const n = Number(d.rewardAmount)
                  return d.rewardAmount.trim() !== "" && Number.isFinite(n) ? Math.trunc(n) : 10
                })(),
              }
          : null
  const conditionParams = isLottery
    ? {
        winners: Math.floor(Number(d.lotteryWinners)) || 1,
        pool: Math.floor(Number(d.lotteryPool)) || 1,
        mode: d.lotteryMode,
      }
    : (d.conditionType === "quiz" || (d.conditionType === "vote" && d.quizMode))
      ? // 问卷：直接把粘贴的 JSON 解析后作为 condition_params（形状由后端 parseQuizConfig 校验）
        (JSON.parse(d.quizJson) as Record<string, unknown>)
      : d.conditionType === "vote"
      ? {
          // 只提交填了标题的选项（空行是编辑时的占位，不该进库）；
          // 后端还会再校验「至少 2 个」并在不满足时拒掉。
          options: d.voteOptions
            .filter((o) => o.label.trim())
            .map((o) => ({
              id: o.key,
              label: o.label.trim(),
              ...(o.desc.trim() ? { desc: o.desc.trim() } : {}),
              ...(o.image.trim() ? { image: o.image.trim() } : {}),
            })),
          rewardRule: d.voteRule,
          // 「指定选项获奖」必须带上获奖选项；其它规则不提交（避免残留脏值让后端误判）
          ...(isFixedVoteRule(d.voteRule) ? { fixedOptionId: d.voteFixedOptionId } : {}),
        }
      : d.conditionType === "has_feature"
        ? { feature: d.conditionFeature }
        : d.conditionType === "code"
          ? { code: d.conditionCode.trim() }
          : d.conditionType === "github_star" || d.conditionType === "github_pr"
            ? { repo: d.conditionRepo.trim() }
            : null

  const maxClaims = d.maxClaims.trim() === "" ? null : Math.floor(Number(d.maxClaims))
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    status: d.status,
    startsAt: fromLocalInput(d.startsAt),
    endsAt: fromLocalInput(d.endsAt),
    // 仅在「定时发布」时提交时间；其它状态忽略，避免残留脏值
    publishAt: d.status === "scheduled" ? fromLocalInput(d.publishAt) : null,
    // 非正数/Nan → null（不限量）
    maxClaims: maxClaims != null && Number.isFinite(maxClaims) && maxClaims >= 1 ? maxClaims : null,
    rewardLabel: d.rewardLabel.trim() || null,
    // 抽奖固定发积分（后端也会校验，这里是为了提交值自洽）。
    // 投票不限奖励类型 —— 站长要求「奖励不一定是积分，做成可选」。
    rewardType: isLottery ? "points" : d.rewardType,
    rewardParams,
    conditionType: d.conditionType,
    conditionParams,
    promoHidden: d.promoHidden,
  }
}

const EVENT_STATUS_OPTIONS: { value: EventStatus; label: string }[] = [
  { value: "draft", label: "adm.evStatus.draft" },
  { value: "admin_only", label: "adm.evStatus.adminOnly" },
  { value: "scheduled", label: "adm.evStatus.scheduled" },
  { value: "active", label: "adm.evStatus.active" },
  { value: "ended", label: "adm.evStatus.ended" },
  { value: "archived", label: "adm.evStatus.archived" },
]

/**
 * 活动奖励类型（2026-11-06 收敛）。
 *
 * 去掉了 `newapi_quota`（充中转站余额）—— AI 中转站已下线，新活动不该再发这种奖励。
 * 历史活动里若已有该类型，发放逻辑仍保留在 event-rewards.ts，不影响存量领取。
 */
const REWARD_TYPE_OPTIONS: { value: EventRewardType; label: string }[] = [
  { value: "none", label: "adm.reward.none" },
  { value: "invite_quota", label: "adm.reward.inviteQuota" },
  // 积分：记在用户积分余额上，可在商城直接花
  { value: "points", label: "adm.reward.points" },
]

const CONDITION_TYPE_OPTIONS: { value: EventConditionType; label: string }[] = [
  { value: "always", label: "adm.cond.always" },
  { value: "code", label: "adm.cond.code" },
  // 判据是「已发布 **且** 填了昵称」——开通名片默认就是已发布状态，
  // 只卡「已发布」等于点一下开通就能领奖，所以还要有昵称（见 event-rewards.ts）
  { value: "has_profile", label: "adm.cond.profile" },
  { value: "has_feature", label: "adm.cond.feature" },
  // 抽奖：参与只是「报名」，开奖时从报名者里随机抽取中奖者发积分（奖励类型固定为积分）
  { value: "lottery", label: "adm.cond.lottery" },
  // 投票：给定若干选项，一人一票；奖励规则可选「参与即可获奖 / 多数 / 少数」，
  // 其中多数与少数又分「投票后立刻按当前票数结算」和「截止后开奖」两种
  { value: "vote", label: "adm.cond.vote" },
  { value: "quiz", label: "问卷（多题，按答对率发奖）" },
  // 点 star：用户填自己的 GitHub 用户名，服务端去该仓库的 stargazers 名单里核验
  { value: "github_star", label: "adm.cond.githubStar" },
  // 提交 PR：用户填自己的 GitHub 用户名，服务端核验其有没有给该仓库提过 PR
  { value: "github_pr", label: "adm.cond.githubPr" },
]

/** 投票获奖规则的可选项（顺序 = 表单里的展示顺序：先「立刻结算」再「截止后开奖」） */
const VOTE_RULE_OPTIONS: { value: EventVoteRewardRule; label: string }[] = [
  { value: "all", label: "vote.rule.all" },
  { value: "instant_fixed", label: "vote.rule.instantFixed" },
  { value: "instant_majority", label: "vote.rule.instantMajority" },
  { value: "instant_minority", label: "vote.rule.instantMinority" },
  { value: "fixed", label: "vote.rule.fixed" },
  { value: "majority", label: "vote.rule.majority" },
  { value: "minority", label: "vote.rule.minority" },
]

const EVENT_STATUS_BADGE: Record<EventStatus, "default" | "secondary" | "success" | "outline"> = {
  draft: "secondary",
  admin_only: "secondary",
  scheduled: "default",
  active: "success",
  ended: "outline",
  archived: "secondary",
}

const EVENT_STATUS_TEXT: Record<EventStatus, string> = {
  draft: "adm.evStatus.draft",
  admin_only: "adm.evStatus.adminOnlyShort",
  scheduled: "adm.evStatus.scheduledShort",
  active: "adm.evStatus.activeShort",
  ended: "adm.evStatus.endedShort",
  archived: "adm.evStatus.archivedShort",
}

/**
 * 问卷 JSON 的一键示例（后台「填入示例」按钮用）。
 *
 * ⚠️ 档位参数必须是 **amount** —— points 发奖 handler 读的就是这个字段，
 * 写成 points 会在**保存时**被服务端拒掉（见 worker/src/event-rewards.ts 的校验）。
 * 这个模板本身就是「能被保存、能跑通」的最小可用配置，改标题/选项即可用。
 */
const QUIZ_TEMPLATE = JSON.stringify(
  {
    mode: "quiz",
    questions: [
      {
        id: "q1",
        title: "1 + 1 等于几？",
        options: [
          { id: "a", label: "2" },
          { id: "b", label: "3" },
        ],
        correctOptionId: "a",
      },
    ],
    retake: "once",
    reveal: "immediate",
    // 默认给「按答对率线性折算」：答对 80% 就拿满分的 80%。
    // 想改成"达到门槛给固定分"，在图形化界面的「发奖口径」里切成"按答对率分档"即可。
    scoring: { kind: "linear", maxPoints: 10 },
  },
  null,
  2
)

/**
 * 侧边栏分组归属（2026-10-25 分组默认折叠）：tab → 分组键（= NavGroup 的 i18n label key）。
 * 「用户」不在任何分组里（常驻顶栏）；当前 tab 所在的分组**强制展开** ——
 * 否则路由直达 /admin/settings 时侧边栏全是收起的，用户不知道自己在哪。
 */
const TAB_GROUP: Record<string, string> = {
  users: "adm.215",
  invites: "adm.215",
  inviteQuotas: "adm.215",
  reserved: "adm.215",
  titles: "adm.215",
  moderation: "adm.215",
  notices: "adm.215",
  announcements: "adm.226",
  events: "adm.226",
  points: "adm.226",
  community: "adm.226",
  feedback: "adm.226",
  oauth: "adm.234",
  analytics: "adm.234",
  cfQuota: "adm.234",
  perf: "adm.234",
  audit: "adm.234",
  settings: "adm.234",
  permissions: "adm.234",
}

/** 侧边栏展开状态存 localStorage：管理员手动展开的分组跨刷新保留 */
const NAV_OPEN_KEY = "admin-nav-open"

/** 管理面板全部子 tab（与路由 /admin/:tab 一一对应） */
const ADMIN_TAB_KEYS = new Set([
  "users", "invites", "inviteQuotas", "reserved", "titles", "points",
  "feedback", "announcements", "events", "community", "moderation", "notices",
  "analytics", "cfQuota", "audit",
  "oauth", "settings", "permissions", "perf",
])

export default function AdminPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [filter, setFilter] = React.useState("")
  /** 用户列表多选模式：常驻只有一个「编辑」按钮，进了模式才出现行勾选框 */
  const [selectMode, setSelectMode] = React.useState(false)
  const [selectedUserIds, setSelectedUserIds] = React.useState<Set<string>>(new Set())
  /** 批量封禁 / 解封弹窗 */
  const [bulkAction, setBulkAction] = React.useState<"suspend" | "unsuspend" | null>(null)
  const [bulkReason, setBulkReason] = React.useState("")
  const [bulkBusy, setBulkBusy] = React.useState(false)
  /**
   * 用户列表服务端分页（2026-10-08 性能）：全量模式 1399 用户 ~870KB、TTFB ~1.7s，
   * 改为每页 50 条 + 服务端搜索（~20KB、~1.0s）。`serverTotal` 为 null 表示仍在
   * 兼容模式（不该出现，只在接口异常回退时兜底显示「无分页信息」）。
   */
  const [userPage, setUserPage] = React.useState(0)
  const [serverTotal, setServerTotal] = React.useState<number | null>(null)
  /** 不受搜索影响的总数，供页面头部统计用（serverTotal 会随搜索结果变化） */
  const [userTotalAll, setUserTotalAll] = React.useState<number | null>(null)
  const USER_PAGE_SIZE = 50
  /** 「注册 IP」列默认隐藏（站长 2026-10-03 要求）：列较多时默认不占地方，需要时用搜索框右边的开关打开 */
  const [showRegisterIp, setShowRegisterIp] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  // 当前栏目由**真路由** /admin/:tab 决定（原先是 /dashboard/admin#hash）。
  // 可直达、可分享、刷新/后退都自然工作；非法栏目名回落到「用户」栏。
  const params = useParams<{ tab?: string }>()
  const navigate = useNavigate()
  const activeTab = ADMIN_TAB_KEYS.has(params.tab ?? "") ? (params.tab as string) : "users"

  // 侧边栏分组折叠：默认全收起；手动展开的分组记进 localStorage；
  // 当前 tab 所在分组始终展开（见 TAB_GROUP 注释）。水合 try-catch：
  // 隐私模式 / 旧值损坏时回落「全部收起」，不能让整个后台崩掉。
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_OPEN_KEY)
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set()
    } catch {
      return new Set()
    }
  })
  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...next]))
      } catch {
        /* 存不进去就算了：本次会话内折叠仍然生效 */
      }
      return next
    })
  }
  /** 分组是否展开：手动展开 ∨ 含当前 tab */
  const groupOpen = (key: string) => openGroups.has(key) || TAB_GROUP[activeTab] === key
  // 各栏目「待处理」角标（反馈 / 捐献 / 积分 / 活动），与侧边栏「管理」总角标同源
  const [attention, setAttention] = React.useState<AttentionCounts["admin"]>(null)

  // 权限树 + 当前管理员权限，用于「只显示有权限的侧边栏栏目」
  const [permCategories, setPermCategories] = React.useState<AdminPermCategory[]>([])
  const [myScope, setMyScope] = React.useState<Set<string> | null>(null)
  const [sidebarOnlyPermitted, setSidebarOnlyPermitted] = React.useState(false)

  const [detail, setDetail] = React.useState<AdminUserDetail | null>(null)
  const [detailUser, setDetailUser] = React.useState<string>("")
  const [openedMessage, setOpenedMessage] = React.useState<MailMessage | null>(null)
  /** 成员详情里「对齐中转站状态」按钮的忙碌态 */

  /** 封禁原因输入框（正式对话框，替代浏览器原生 prompt，支持多行备注） */
  const [suspendTarget, setSuspendTarget] = React.useState<{
    username: string
    status: string
  } | null>(null)
  const [suspendReasonText, setSuspendReasonText] = React.useState("")
  const [suspendBusy, setSuspendBusy] = React.useState(false)

  // 邀请码
  const [invites, setInvites] = React.useState<AdminInvite[]>([])
  const [inviteLoading, setInviteLoading] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteMax, setInviteMax] = React.useState("1")
  const [inviteBusy, setInviteBusy] = React.useState(false)
  /** 邀请码分类筛选："" 全部 / "unused" 未使用 / "partial" 部分使用 / "used" 已使用 */
  const [inviteFilter, setInviteFilter] = React.useState<string>("")
  /**
   * 邀请码列表服务端分页（2026-10-08）：原先无分页、切到该 tab 要等明显一下。
   * `inviteTotalAll` 是**不受筛选影响的总数**，供页面头部统计显示（进页面即有值）。
   */
  const [invitePage, setInvitePage] = React.useState(0)
  const [inviteTotal, setInviteTotal] = React.useState<number | null>(null)
  const [inviteTotalAll, setInviteTotalAll] = React.useState<number | null>(null)
  /** counts[""] = 全部，其余为各分类；来自接口的 GROUP BY */
  const [inviteCounts, setInviteCounts] = React.useState<Record<string, number> | null>(null)
  const invitesLoadedRef = React.useRef(false)
  const [invitePerms, setInvitePerms] = React.useState<Permissions>({
    r2: true,
    ai: true,
    // ⚠️ `frp` 权限已随内网穿透租用化退役（后端 FEATURES 不再含它），界面上也不再
    // 渲染这个勾选框；但 `Permissions` 类型仍要求该键，后端读权限 JSON 时会忽略这个
    // 残留键（见 worker/src/permissions.ts 的注释），故保留占位。
    frp: true,
    proxy: true,
    // doulor.cn 专属域默认**不开**：建码时要显式勾选才会授予
    // （与后端 allPermissions() 的口径一致，见 worker/src/permissions.ts）
    doulor: false,
    // 中转站免审入驻同样默认**不开**：它是「信任」不是「功能」，
    // 建码时默认带上它等于把中转站审核制从邀请码这条路绕过去。
    relay_auto: false,
  })

  /** 邀请码溯源弹窗（站长 2026-10-07：用户列表点邀请码、邀请码列表点码都能打开） */
  const [traceCode, setTraceCode] = React.useState<string | null>(null)
  const [traceData, setTraceData] = React.useState<AdminInviteTrace | null>(null)
  const [traceBusy, setTraceBusy] = React.useState(false)
  /**
   * 用户详情「最近活动」懒加载分页（2026-10-07 站长要求：支持查看更多）。
   * 首屏 20 条来自详情接口本身，更多走 /users/:username/activity 往后翻。
   */
  const [activityExtra, setActivityExtra] = React.useState<AuditLog[]>([])
  const [activityHasMore, setActivityHasMore] = React.useState(false)
  const [activityBusy, setActivityBusy] = React.useState(false)

  // 用户详情里的昵称编辑（与配额一样先存草稿，点保存才提交）
  const [nickDraft, setNickDraft] = React.useState("")

  // 「重置密码」弹窗（rootOnly）：输入新密码 → 提交
  const [pwOpen, setPwOpen] = React.useState(false)
  const [pwValue, setPwValue] = React.useState("")
  const [pwShow, setPwShow] = React.useState(false)
  const [pwBusy, setPwBusy] = React.useState(false)

  // 编辑邀请码权限
  const [permInvite, setPermInvite] = React.useState<AdminInvite | null>(null)
  const [permDraft, setPermDraft] = React.useState<Permissions | null>(null)
  const [permBusy, setPermBusy] = React.useState(false)

  // 用户邀请码额度
  const [inviteQuotas, setInviteQuotas] =
    React.useState<AdminInviteQuotasResponse | null>(null)
  const [inviteQuotaLoading, setInviteQuotaLoading] = React.useState(false)
  /** 用户邀请码列表的顶部搜索（用户名 / 邮箱 / 域名），与用户列表同款 */
  const [quotaFilter, setQuotaFilter] = React.useState("")
  const [quotaDetail, setQuotaDetail] =
    React.useState<AdminUserInviteQuotaResponse | null>(null)
  const [quotaDetailBusy, setQuotaDetailBusy] = React.useState(false)

  /** 会员银行卡号发放弹窗（null = 关闭；值是用户名） */
  const [cardNoUser, setCardNoUser] = React.useState<string | null>(null)

  // 保留子域名
  // 昵称保留词（与保留域名同页管理）
  const [nickReserved, setNickReserved] = React.useState<string[]>([])
  const [nickReservedInput, setNickReservedInput] = React.useState("")
  const [nickReservedBusy, setNickReservedBusy] = React.useState(false)

  // 公告 / 网站动态
  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  const [announcementLoading, setAnnouncementLoading] = React.useState(false)
  const [announcementOpen, setAnnouncementOpen] = React.useState(false)
  const [announcementBusy, setAnnouncementBusy] = React.useState(false)
  const [annDraft, setAnnDraft] = React.useState<{
    id: string | null
    title: string
    body: string
    category: string
    pinned: boolean
    popupMode: "none" | "once" | "every"
    notifyByEmail: boolean
    /** draft=草稿；scheduled=定时发布；published=立即发布 */
    status: AnnouncementStatus
    /** datetime-local 值（本地时区）；status=scheduled 时用 */
    publishAt: string
  }>({
    id: null,
    title: "",
    body: "",
    category: "general",
    pinned: false,
    popupMode: "none",
    notifyByEmail: false,
    status: "published",
    publishAt: "",
  })

  // 活动（消息中心「活动推广」）
  const [events, setEvents] = React.useState<EventItem[]>([])
  const [eventLoading, setEventLoading] = React.useState(false)
  const [eventOpen, setEventOpen] = React.useState(false)
  const [eventBusy, setEventBusy] = React.useState(false)
  const [eventDraft, setEventDraft] = React.useState<EventDraft>(emptyEventDraft())
  /**
   * 当前是不是在编「问卷」。
   * 独立类型 quiz 与旧的「投票 + 问卷形态」都算 —— 界面统一用它判断，
   * 这样下拉里选「问卷」就**立即**出现图形化编辑器、并且投票那套（选项/获奖规则）自动消失。
   */
  const quizActive = eventDraft.conditionType === "quiz" || eventDraft.quizMode
  /** 领取名单弹窗 */
  const [claimsOpen, setClaimsOpen] = React.useState(false)
  const [claimsEvent, setClaimsEvent] = React.useState<EventItem | null>(null)
  const [claims, setClaims] = React.useState<EventClaim[]>([])
  const [claimsLoading, setClaimsLoading] = React.useState(false)
  /**
   * 投票选项配图上传：`voteImgTarget` 记住「这次点的是哪个选项的按钮」。
   *
   * 为什么用一个隐藏 input + 记住目标：每个选项都放一个 <input type="file">
   * 会让 DOM 里堆一批同构控件；共用一个 input、点击前记下目标选项更省，
   * 代价是必须在选中后立刻清空 value（否则同一个文件再选一次不触发 change）。
   */
  const voteImgInputRef = React.useRef<HTMLInputElement>(null)
  const voteImgTargetRef = React.useRef<string | null>(null)
  /** 正在上传配图的选项 key（null = 没有上传在进行） */
  const [voteImgUploading, setVoteImgUploading] = React.useState<string | null>(null)
  /** 刚复制过链接的活动 id（用于把图标短暂切成「已复制」，2 秒后复原） */
  const [copiedEventId, setCopiedEventId] = React.useState<string | null>(null)

  /**
   * 复制某场活动的分享链接（`/activity/<id>`，未登录也能打开）。
   *
   * 与用户端卡片上的「分享」是同一个地址。管理端需要它是因为
   * 「不在活动推广显示」的活动只能靠链接传播 —— 站长得有个地方方便地把链接拿出来。
   *
   * 剪贴板 API 在非 https / 无权限时会抛错，此时降级成把链接显示出来让用户手动复制
   * （与用户端 event card 的处理一致，不要静默失败）。
   */
  const copyEventLink = async (ev: EventItem) => {
    const url = `${window.location.origin}/activity/${ev.id}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedEventId(ev.id)
      setTimeout(() => setCopiedEventId((cur) => (cur === ev.id ? null : cur)), 2000)
      toast.success(t("msg.shareCopied"))
    } catch {
      toast.message(t("msg.shareCopyFailed"), { description: url })
    }
  }

  // 全局设置
  const [settingsLoading, setSettingsLoading] = React.useState(false)
  const [settingsBusy, setSettingsBusy] = React.useState(false)

  // 每日签到配置（基础区间 + 连续里程碑，全部站长手填）
  const [checkinEnabled, setCheckinEnabled] = React.useState(true)
  const [checkinMin, setCheckinMin] = React.useState("1")
  const [checkinMax, setCheckinMax] = React.useState("5")
  const [checkinMilestones, setCheckinMilestones] = React.useState("7:50\n30:300\n100:1000")
  /** NewAPI quota ↔ 金额换算率（由服务端 newapi_quota_per_unit 提供） */
  const [quotaPerUnit, setQuotaPerUnit] = React.useState(500000)
  /** 展示币种符号，跟随 NewAPI 站点设置 */
  /** 推荐模型分档（管理员维护，用户在 AI 页看到的就是这份） */
  const [recommendedTiers, setRecommendedTiers] = React.useState<RecommendedTier[]>([])

  // ---- 2026-09-26 补齐：以下设置项后端一直有默认值，但面板从没有输入框 ----
  /** 免费订阅套餐 id（0 = 不自动开订阅） */
  /** quota ↔ 金额换算率的可编辑值 */
  /** 邀请奖励总开关 */
  /** 邀请奖励：反代绑定奖励套餐 id */
  /** 邀请奖励：AI 渠道捐献奖励套餐 id */
  const [inviteRewardAiPlanId, setInviteRewardAiPlanId] = React.useState("3")
  /** 成就奖励总开关 */
  const [achievementRewardEnabled, setAchievementRewardEnabled] = React.useState(false)
  /** 成就奖励套餐 id */
  const [achievementRewardPlanId, setAchievementRewardPlanId] = React.useState("4")
  /** 每满多少成就点发一份 */
  const [achievementRewardPoints, setAchievementRewardPoints] = React.useState("10")
  /** 每个用户默认的邀请码额度 */
  const [inviteQuotaBase, setInviteQuotaBase] = React.useState("3")
  /** 代理节点功能总开关 */
  /** 新反馈通知邮箱（空 = 不通知） */

  // ---- WorkBuddy 反代账号捐献（登录即解锁 AI 权限）----
  /** 通道开关与限额（走全局设置接口，与其它开关一起保存） */
  const [wb2apiEnabled, setWb2apiEnabled] = React.useState(true)
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响通道本身） */
  const [wb2apiDonationVisible, setWb2apiDonationVisible] = React.useState(true)
  const [wb2apiMaxBindings, setWb2apiMaxBindings] = React.useState("3")
  const [wb2apiBaseUrl, setWb2apiBaseUrl] = React.useState("")
  const [wb2apiRealm, setWb2apiRealm] = React.useState<"cn" | "global">("cn")
  /** 国内版 / 国际版可用开关（关掉哪版，用户就不能在捐献/邀请里选哪版） */
  const [wb2apiRealmCn, setWb2apiRealmCn] = React.useState(true)
  const [wb2apiRealmGlobal, setWb2apiRealmGlobal] = React.useState(true)

  // ---- Qoder2API 反代账号捐献（第二条通道）----
  /** 通道开关 / 上限 / 区域（走全局设置接口，与其它开关一起保存） */
  const [qoder2apiEnabled, setQoder2apiEnabled] = React.useState(true)
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响通道本身） */
  const [qoder2apiDonationVisible, setQoder2apiDonationVisible] = React.useState(true)
  /** 允许用户自选的版本（2026-10-10，与 wb2api 的两个开关同款）：
   *  关掉的版本在捐献页隐藏、接口层拒绝用它发起绑定 */
  const [qoder2apiRealmCn, setQoder2apiRealmCn] = React.useState(true)
  const [qoder2apiRealmIntl, setQoder2apiRealmIntl] = React.useState(true)
  const [qoder2apiMaxBindings, setQoder2apiMaxBindings] = React.useState("3")
  const [qoder2apiBaseUrl, setQoder2apiBaseUrl] = React.useState("")
  /** 上游区域：cn / intl（该通道只对接 Qoder，无 provider 可切） */
  const [qoder2apiRealm, setQoder2apiRealm] = React.useState("cn")

  // 商汤 Key 捐献通道
  const [sensenovaEnabled, setSensenovaEnabled] = React.useState(true)
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响提交接口） */
  const [sensenovaDonationVisible, setSensenovaDonationVisible] = React.useState(true)
  const [sensenovaBaseUrl, setSensenovaBaseUrl] = React.useState("")
  /** 捐献来的 Key 要并入的渠道 ID（NewAPI 渠道 ID，必须是多密钥渠道） */
  const [sensenovaChannelId, setSensenovaChannelId] = React.useState("")
  // 落地页「下载」区的安卓 / Windows 链接
  const [downloadAndroidUrl, setDownloadAndroidUrl] = React.useState("")
  const [downloadWindowsUrl, setDownloadWindowsUrl] = React.useState("")
  // 出站邮件通道
  const [mailTransportOrder, setMailTransportOrder] = React.useState("posta,brevo,cf")
  const [announcementMailTransport, setAnnouncementMailTransport] = React.useState("posta")
  const [mailCfTargets, setMailCfTargets] = React.useState("")
  const [postaUrl, setPostaUrl] = React.useState("")
  const [postaKey, setPostaKey] = React.useState("")
  const [postaFrom, setPostaFrom] = React.useState("")
  const [brevoSenderEmail, setBrevoSenderEmail] = React.useState("")
  const [brevoSenderName, setBrevoSenderName] = React.useState("Doulor Cloud")
  // 临时分享箱
  /** 新反馈通知邮箱（空 = 不通知） */
  const [feedbackNotifyEmail, setFeedbackNotifyEmail] = React.useState("")
  /**
   * 首捐奖励券可兑换的模块（默认全部可兑换）。
   * 用户第一次捐献成功后拿到的「自选权限」券只能换这里勾上的模块。
   * 后端读取口径见 worker/src/vouchers.ts 的 parseFirstDonationFeatures。
   */
  // 限时开放注册：打开后注册无需邀请码；可设截止时间（datetime-local 本地值）
  const [openRegistration, setOpenRegistration] = React.useState(false)
  const [openRegistrationUntil, setOpenRegistrationUntil] = React.useState("")
  // 注册准入（2026-10-02）：邮箱域名白名单 + 同 IP 累计注册上限
  const [registerEmailDomains, setRegisterEmailDomains] = React.useState("")
  const [registerIpDailyLimit, setRegisterIpDailyLimit] = React.useState("3")
  /** 风险账户判定阈值（单账号每分钟请求数） */
  const [riskPeakThreshold, setRiskPeakThreshold] = React.useState("20")

  // ---- 社区管理 ----
  const [communityPosts, setCommunityPosts] = React.useState<AdminCommunityPost[]>([])
  const [communityLoading, setCommunityLoading] = React.useState(false)
  const [communityShowDeleted, setCommunityShowDeleted] = React.useState(false)
  const [communityUserFilter, setCommunityUserFilter] = React.useState("")
  // 社区广场设置
  const [communityEnabled, setCommunityEnabled] = React.useState(true)
  /** 聊天室总开关（应急断流用：聊天是请求与写库的大头）。默认按「关」展示，加载后被真实值覆盖 */
  const [chatEnabled, setChatEnabled] = React.useState(false)
  const [communityGuestAccess, setCommunityGuestAccess] = React.useState(true)
  const [communityPostMaxImages, setCommunityPostMaxImages] = React.useState("9")
  const [communityImageMaxKb, setCommunityImageMaxKb] = React.useState("1024")
  /** 评论最多可修改次数（0 = 禁止修改）；2026-10-17 站长要求默认 2 次 */
  const [communityCommentEditLimit, setCommunityCommentEditLimit] = React.useState("2")
  /** 站点时区偏移（小时），默认 8 = 北京时间 0 点翻篇 */
  const [siteTzOffsetHours, setSiteTzOffsetHours] = React.useState("8")
  /**
   * 帖子分类（管理面板可配，2026-10-07）。
   * 空数组 = 还没加载到（保存时若为空则**不动这项**，避免把分类清空）。
   */
  const [postCategories, setPostCategories] = React.useState<PostCategoryDef[]>([])

  /** 改动第 i 个分类的某个字段（分类编辑区用） */
  const patchCategory = React.useCallback((i: number, patch: Partial<PostCategoryDef>) => {
    setPostCategories((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }, [])

  /**
   * 拉用户列表（服务端分页）。`page`/`filter` 由调用处给（刷新场景保留当前页），
   * 不从 state 读 —— 这样「删完用户刷新」可以显式选择回第一页或留在原页。
   */
  const loadUserPage = React.useCallback(
    async (page: number, q: string) => {
      setLoading(true)
      try {
        const res = await adminApi.listUsers({
          q: q || undefined,
          limit: USER_PAGE_SIZE,
          offset: page * USER_PAGE_SIZE,
        })
        setUsers(res.users)
        // 列表换了（翻页/搜索）⇒ 勾选作废：对看不见的行做批量操作太危险
        setSelectedUserIds(new Set())
        setServerTotal(res.total ?? null)
        // 无搜索词时记下「全站总数」，供页面头部统计（搜索时 total 会变，不能拿它当总数）
        if (!q && res.total != null) setUserTotalAll(res.total)
      } catch (err) {
        toast.error(err instanceof HttpError ? err.message : t("adm.1"))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  // 搜索防抖：停手 300ms 再发请求（每次击键都打 D1 既慢又费）。
  // 搜索词变了就回到第一页 —— 用 ref 记上一次的词：直接给 loadUserPage 传 page=0
  // （发请求的是它），setUserPage(0) 只是同步状态；即便它触发 effect 重跑，
  // 上一个 300ms 的定时器也已被 cleanup 取消，不会双请求。
  const lastFilterRef = React.useRef(filter)
  React.useEffect(() => {
    const q = filter.trim()
    const page = lastFilterRef.current === q ? userPage : 0
    if (lastFilterRef.current !== q) {
      lastFilterRef.current = q
      setUserPage(0)
    }
    const h = window.setTimeout(() => void loadUserPage(page, q), 300)
    return () => window.clearTimeout(h)
  }, [loadUserPage, userPage, filter])

  /** 初始加载与「操作后刷新」：留在当前页/当前搜索词 */
  const load = React.useCallback(async () => {
    await loadUserPage(userPage, filter.trim())
  }, [loadUserPage, userPage, filter])

  /** 批量封禁 / 解封：走与单人编辑完全同一条后端链路（资源停用、IP 拉黑、NewAPI 同步） */
  const submitBulkStatus = async () => {
    if (!bulkAction) return
    if (bulkAction === "suspend" && !bulkReason.trim()) {
      toast.error(t("adm.suspendReasonRequired"))
      return
    }
    setBulkBusy(true)
    try {
      const res = await adminApi.bulkSetStatus({
        userIds: [...selectedUserIds],
        action: bulkAction,
        ...(bulkAction === "suspend" ? { reason: bulkReason.trim() } : {}),
      })
      toast.success(
        bulkAction === "suspend"
          ? t("adm.sel.suspendDone", { n: String(res.updated) })
          : t("adm.sel.unsuspendDone", { n: String(res.updated) })
      )
      setBulkAction(null)
      setBulkReason("")
      setSelectedUserIds(new Set())
      setSelectMode(false)
      await load()
    } catch (err) {
      // 与文件内其它接口同一套错误口径（admin.tsx 不用 errMsg）
      toast.error(err instanceof HttpError ? err.message : t("adm.sel.failed"))
    } finally {
      setBulkBusy(false)
    }
  }

  /**
   * 拉邀请码列表（服务端分页 + 分类筛选，2026-10-08 与用户/捐献同批）。
   * 原先无分页、一次拉全量，切到该 tab 要等明显一下。
   */
  const loadInvitePage = React.useCallback(
    async (page: number, status: string) => {
      setInviteLoading(true)
      try {
        const res = await adminApi.listInvites({
          limit: INVITE_PAGE_SIZE,
          offset: page * INVITE_PAGE_SIZE,
          status: status || undefined,
        })
        setInvites(res.invites)
        setInviteTotal(res.total ?? null)
        setInviteCounts(res.counts ?? null)
      } catch (err) {
        toast.error(err instanceof HttpError ? err.message : t("adm.2"))
      } finally {
        setInviteLoading(false)
      }
    },
    [t]
  )

  // 分类或页码变化 → 重新拉。⚠️ 门卫同捐献 tab：初次挂载不拉，
  // 首次加载由 loadInvites() 把 ref 置真（那颗 ref 见下）。
  React.useEffect(() => {
    if (!invitesLoadedRef.current) return
    void loadInvitePage(invitePage, inviteFilter)
  }, [loadInvitePage, invitePage, inviteFilter])

  /** 拉邀请码列表（保留当前页与筛选）；首次调用顺带打开门卫 */
  const loadInvites = React.useCallback(async () => {
    invitesLoadedRef.current = true
    await loadInvitePage(invitePage, inviteFilter)
  }, [loadInvitePage, invitePage, inviteFilter])

  /**
   * 页面头部的统计「已注册用户 N 个 · 邀请码 M 个」。
   * 邀请码总数以前要等用户切到 invite tab 才有值（一直显示 0）—— 这里在挂载时
   * 单独取一次（count_only，只一条 COUNT，很轻），进页面就能看到正确数字。
   */
  React.useEffect(() => {
    let cancelled = false
    adminApi
      .listInvites({ countOnly: true })
      .then((r) => !cancelled && setInviteTotalAll(r.total ?? 0))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreateInvite = async () => {
    setInviteBusy(true)
    try {
      await adminApi.createInvite({
        code: inviteCode,
        maxUses: Number(inviteMax) || 1,
        permissions: invitePerms,
      })
      toast.success(t("adm.3"))
      setInviteCode("")
      setInviteMax("1")
      setInviteOpen(false)
      // 新码按创建时间倒序排在最前；若停在别的页会看不到，所以回第一页。
      // 直接给 loadInvitePage 传 page=0 / status=""（列表按创建时间倒序、新码必在全部里）。
      setInvitePage(0)
      setInviteFilter("")
      void loadInvitePage(0, "")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.4"))
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (invite: AdminInvite) => {
    try {
      await adminApi.deleteInvite(invite.id)
      toast.success(t("adm.5"))
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.6"))
    }
  }

  // ---- 社区管理 ----

  const loadCommunity = React.useCallback(async () => {
    setCommunityLoading(true)
    try {
      const res = await adminApi.listCommunityPosts({ includeDeleted: communityShowDeleted, user: communityUserFilter || undefined })
      setCommunityPosts(res.posts)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.34"))
    } finally {
      setCommunityLoading(false)
    }
  }, [communityShowDeleted, communityUserFilter])

  const handleDeleteCommunityPost = async (id: string) => {
    try {
      await adminApi.deleteCommunityPost(id)
      toast.success(t("adm.35"))
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.36"))
    }
  }

  const handleRestoreCommunityPost = async (id: string) => {
    try {
      await adminApi.restoreCommunityPost(id)
      toast.success(t("adm.37"))
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.38"))
    }
  }

  // ---- 全局设置 ----

  const loadSettings = React.useCallback(async () => {
    setSettingsLoading(true)
    try {
      const res = await adminApi.getSettings()
      const s = res.settings
      // 每日签到配置
      setCheckinEnabled(isSettingOn(s.checkin_enabled, true))
      setCheckinMin(String(Number(s.checkin_points_min ?? 1) || 1))
      setCheckinMax(String(Number(s.checkin_points_max ?? 5) || 5))
      setCheckinMilestones(s.checkin_milestones ?? "7:50\n30:300\n100:1000")
      const perUnit = Number(s.newapi_quota_per_unit ?? 500000)
      // 记下服务端的换算率：保存时要按同一比率换算回去，
      // 否则改了 quota_per_unit 后「显示 $X」再保存会写成另一个额度
      setQuotaPerUnit(perUnit)
      // 反代账号捐献通道
      setWb2apiEnabled(isSettingOn(s.wb2api_enabled, true))
      setWb2apiDonationVisible(isSettingOn(s.wb2api_donation_visible, true))
      setWb2apiMaxBindings(s.wb2api_max_bindings ?? "3")
      setWb2apiBaseUrl(s.wb2api_base_url ?? "")
      setWb2apiRealm(s.wb2api_realm === "global" ? "global" : "cn")
      setWb2apiRealmCn(isSettingOn(s.wb2api_realm_cn, true))
      setWb2apiRealmGlobal(isSettingOn(s.wb2api_realm_global, true))
      // Qoder2API 反代账号捐献通道
      setQoder2apiEnabled(isSettingOn(s.qoder2api_enabled, true))
      setQoder2apiDonationVisible(isSettingOn(s.qoder2api_donation_visible, true))
      setQoder2apiRealmCn(isSettingOn(s.qoder2api_realm_cn, true))
      setQoder2apiRealmIntl(isSettingOn(s.qoder2api_realm_intl, true))
      setQoder2apiMaxBindings(s.qoder2api_max_bindings ?? "3")
      setQoder2apiBaseUrl(s.qoder2api_base_url ?? "")
      setQoder2apiRealm(s.qoder2api_realm ?? "cn")
      // 商汤 Key 捐献通道
      setSensenovaEnabled(isSettingOn(s.sensenova_enabled, true))
      setSensenovaDonationVisible(isSettingOn(s.sensenova_donation_visible, true))
      setSensenovaBaseUrl(s.sensenova_base_url ?? "")
      setSensenovaChannelId(s.sensenova_channel_id ?? "")
      // 推荐模型分档：坏 JSON 一律当空，不能让一个脏设置项把整个设置页打崩
      try {
        const parsed = JSON.parse(s.newapi_recommended_models ?? "[]")
        setRecommendedTiers(Array.isArray(parsed) ? (parsed as RecommendedTier[]) : [])
      } catch {
        setRecommendedTiers([])
      }
      setDownloadAndroidUrl(s.download_android_url ?? "")
      setDownloadWindowsUrl(s.download_windows_url ?? "")
      setCommunityEnabled(isSettingOn(s.community_enabled, true))
      // ⚠️ 默认 false 而不是 true：这个开关是应急断流用的，取不到值时按「关」更安全
      setChatEnabled(isSettingOn(s.chat_enabled, false))
      // ⚠️ 原先是 `!== "0"` ⇒ 存了 "false" 时显示「允许访客」，与后端相反
      setCommunityGuestAccess(isSettingOn(s.community_guest_access, true))
      setCommunityPostMaxImages(s.community_post_max_images ?? "9")
      setCommunityImageMaxKb(
        String(Math.round(Number(s.community_image_max_bytes ?? 1048576) / 1024))
      )
      setCommunityCommentEditLimit(s.community_comment_edit_limit ?? "2")
      setSiteTzOffsetHours(s.site_timezone_offset_hours ?? "8")
      setPostCategories(parseCategorySetting(s.post_categories))
      // 限时开放注册：总开关 + 截止时间（后端存 ISO，转成本地 datetime-local 显示）
      setOpenRegistration(isSettingOn(s.open_registration, false))
      setOpenRegistrationUntil(toLocalInput(s.open_registration_until || null))
      setRegisterEmailDomains(s.register_email_domains ?? "")
      setRegisterIpDailyLimit(s.register_ip_daily_limit ?? "3")
      setRiskPeakThreshold(s.risk_peak_per_minute_threshold ?? "20")
      // 捐献 baseUrl 黑名单：后端存的是归一化后的文本，这里原样回显（前端不再加工，
      // 免得两套归一化口径打架）
      // ---- 2026-09-26 补齐的设置项 ----
      setInviteRewardAiPlanId(s.invite_reward_ai_plan_id ?? "3")
      setAchievementRewardEnabled(isSettingOn(s.achievement_reward_enabled, false))
      setAchievementRewardPlanId(s.achievement_reward_plan_id ?? "4")
      setAchievementRewardPoints(s.achievement_reward_points ?? "10")
      setInviteQuotaBase(s.invite_quota_base ?? "3")
      setFeedbackNotifyEmail(s.feedback_admin_notify_email ?? "")
      // 积分系统的开关/比例/每日上限不在这里：改由 管理面板 → 积分 → 商城 维护
      // （见 admin-points.tsx 商品表第一行的「内置商品」行，接口是 PUT /api/admin/points/config）
      // 出站邮件通道
      setMailTransportOrder(s.mail_transport_order ?? "posta,brevo,cf")
      setAnnouncementMailTransport(s.announcement_mail_transport ?? "posta")
      setMailCfTargets(s.mail_cf_targets ?? "")
      setPostaUrl(s.posta_url ?? "")
      setPostaFrom(s.posta_from ?? "")
      setBrevoSenderEmail(s.brevo_sender_email ?? "")
      setBrevoSenderName(s.brevo_sender_name ?? "Doulor Cloud")
      // 密钥明文不回传，输入框清空
      setPostaKey("")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.39"))
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  // 详情弹窗里的 AI 余额要按服务端的 quota 换算率与币种显示，这两项来自
  // 全局设置。进页面就拉一次，避免管理员没点过「设置」标签时用默认值算错。
  React.useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const handleSaveSettings = async () => {
    setSettingsBusy(true)
    try {
      await adminApi.updateSettings({
        checkin_enabled: checkinEnabled,
        checkin_points_min: checkinMin,
        checkin_points_max: checkinMax,
        checkin_milestones: checkinMilestones,
        // JSON 字符串：后端对该键有专门分支（先解析再 sanitize），
        // 不走通用的「截断到 100 字」；空数组会序列化成 "[]" 正常写入。
        newapi_recommended_models: JSON.stringify(
          recommendedTiers
            .map((t) => ({
              tier: t.tier.trim(),
              desc: t.desc.trim(),
              models: t.models.map((m) => m.trim()).filter(Boolean),
            }))
            .filter((t) => t.tier && t.models.length > 0)
        ),
        download_android_url: downloadAndroidUrl.trim(),
        download_windows_url: downloadWindowsUrl.trim(),
        community_enabled: communityEnabled,
        chat_enabled: chatEnabled,
        community_guest_access: communityGuestAccess,
        community_post_max_images: Math.round(Number(communityPostMaxImages) || 9),
        community_image_max_bytes: Math.round(Number(communityImageMaxKb) * 1024),
        // 留空 = 用默认 2 次（不要因为空输入把编辑功能关掉）；非法输入夹到 0–10
        community_comment_edit_limit:
          communityCommentEditLimit.trim() === ""
            ? 2
            : Math.min(10, Math.max(0, Math.round(Number(communityCommentEditLimit) || 0))),
        site_timezone_offset_hours: String(Math.round(Number(siteTzOffsetHours) || 8)),
        // ⚠️ 只在**确实加载到过分类**时才提交这一项：加载失败时 postCategories 是空数组，
        //    无脑提交会把线上分类清空 ——「前端看不见」不等于「要删掉」。
        ...(postCategories.length > 0
          ? { post_categories: serializeCategories(postCategories) }
          : {}),
        // 限时开放注册：总开关 + 截止时间（本地时间转 ISO；留空 = 不自动关闭）
        open_registration: openRegistration,
        open_registration_until: fromLocalInput(openRegistrationUntil) ?? "",
        register_email_domains: registerEmailDomains,
        register_ip_daily_limit: registerIpDailyLimit,
        risk_peak_per_minute_threshold: riskPeakThreshold,
        // 反代账号捐献通道
        wb2api_enabled: wb2apiEnabled,
        wb2api_donation_visible: wb2apiDonationVisible,
        wb2api_max_bindings: String(Math.max(1, Math.round(Number(wb2apiMaxBindings) || 3))),
        wb2api_base_url: wb2apiBaseUrl.trim(),
        wb2api_realm: wb2apiRealm,
        wb2api_realm_cn: wb2apiRealmCn,
        wb2api_realm_global: wb2apiRealmGlobal,
        // Qoder2API 反代账号捐献通道
        qoder2api_enabled: qoder2apiEnabled,
        qoder2api_realm_cn: qoder2apiRealmCn,
        qoder2api_realm_intl: qoder2apiRealmIntl,
        qoder2api_donation_visible: qoder2apiDonationVisible,
        qoder2api_max_bindings: String(Math.max(1, Math.round(Number(qoder2apiMaxBindings) || 3))),
        qoder2api_base_url: qoder2apiBaseUrl.trim(),
        qoder2api_realm: qoder2apiRealm,
        // 商汤 Key 捐献通道
        sensenova_enabled: sensenovaEnabled,
        sensenova_donation_visible: sensenovaDonationVisible,
        sensenova_base_url: sensenovaBaseUrl.trim(),
        // 空串是合法值（= 通道未配置、捐献转人工），要原样提交才能「清空」
        sensenova_channel_id: sensenovaChannelId.trim(),
        invite_reward_ai_plan_id: Math.max(0, Math.round(Number(inviteRewardAiPlanId) || 0)),
        achievement_reward_enabled: achievementRewardEnabled,
        achievement_reward_plan_id: Math.max(0, Math.round(Number(achievementRewardPlanId) || 0)),
        achievement_reward_points: Math.max(1, Math.round(Number(achievementRewardPoints) || 10)),
        invite_quota_base: Math.max(0, Math.round(Number(inviteQuotaBase) || 0)),
        feedback_admin_notify_email: feedbackNotifyEmail.trim(),
        // ---- 出站邮件通道 ----
        // 密钥留空则不更新（后端空串跳过，见 updateSettingsHandler），
        // 所以这里原样传，用户没填新 key 就不会覆盖旧值。
        mail_transport_order: mailTransportOrder.trim(),
        announcement_mail_transport: announcementMailTransport,
        mail_cf_targets: mailCfTargets.trim(),
        posta_url: postaUrl.trim(),
        posta_key: postaKey.trim(),
        posta_from: postaFrom.trim(),
        // brevo_api_key 不在这里提交：明文永不回前端，前端只有打码串、无法原样回传。
        brevo_sender_email: brevoSenderEmail.trim(),
        brevo_sender_name: brevoSenderName.trim(),
      })
      toast.success(t("adm.40"))
      await loadSettings()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.41"))
    } finally {
      setSettingsBusy(false)
    }
  }

  const openInvitePerms = (inv: AdminInvite) => {
    setPermInvite(inv)
    setPermDraft({ ...inv.permissions })
  }

  const handleSaveInvitePerms = async () => {
    if (!permInvite || !permDraft) return
    setPermBusy(true)
    try {
      await adminApi.updateInvite(permInvite.id, { permissions: permDraft })
      toast.success(t("adm.69"))
      setPermInvite(null)
      setPermDraft(null)
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.70"))
    } finally {
      setPermBusy(false)
    }
  }

  const loadInviteQuotas = React.useCallback(async () => {
    setInviteQuotaLoading(true)
    try {
      setInviteQuotas(await adminApi.listInviteQuotas())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.71"))
    } finally {
      setInviteQuotaLoading(false)
    }
  }, [])

  const openQuotaDetail = async (username: string) => {
    setQuotaDetailBusy(true)
    try {
      setQuotaDetail(await adminApi.getUserInviteQuota(username))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.72"))
    } finally {
      setQuotaDetailBusy(false)
    }
  }

  const handleAdjustQuota = async (
    username: string,
    payload: {
      inviteBonus?: number
      featureQuota?: Partial<FeatureCounts>
    }
  ) => {
    setQuotaDetailBusy(true)
    try {
      const res = await adminApi.updateUserInviteQuota(username, payload)
      setQuotaDetail(res)
      toast.success(t("adm.73"))
      void loadInviteQuotas()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.74"))
    } finally {
      setQuotaDetailBusy(false)
    }
  }

  const loadNickReserved = React.useCallback(async () => {
    try {
      const s = await adminApi.getSettings()
      setNickReserved(
        (s.settings.reserved_nicknames ?? "")
          .split(",")
          .map((x: string) => x.trim())
          .filter(Boolean)
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.75"))
    }
  }, [])

  // 昵称保留词：增/删都直接写 settings.reserved_nicknames
  const saveNickReserved = async (next: string[]) => {
    setNickReservedBusy(true)
    try {
      await adminApi.updateSettings({ reserved_nicknames: next.join(",") })
      setNickReserved(next)
      toast.success(t("adm.79"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.80"))
    } finally {
      setNickReservedBusy(false)
    }
  }
  const handleAddNickReserved = async () => {
    const w = nickReservedInput.trim()
    if (!w) return
    if (nickReserved.some((x) => x.toLowerCase() === w.toLowerCase())) {
      toast.error(t("adm.81"))
      return
    }
    await saveNickReserved([...nickReserved, w])
    setNickReservedInput("")
  }
  const handleRemoveNickReserved = (w: string) => {
    void saveNickReserved(nickReserved.filter((x) => x !== w))
  }

  // ---- 公告 ----
  const loadAnnouncements = React.useCallback(async () => {
    setAnnouncementLoading(true)
    try {
      const res = await announcementApi.listAll()
      setAnnouncements(res.announcements)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.82"))
    } finally {
      setAnnouncementLoading(false)
    }
  }, [])

  const openAnnouncementDialog = (a?: Announcement) => {
    setAnnDraft(
      a
        ? {
            id: a.id,
            title: a.title,
            body: a.body,
            category: a.category,
            pinned: a.pinned,
            popupMode: a.popupMode,
            notifyByEmail: a.notifyEmail,
            status: a.status,
            publishAt: toLocalInput(a.publishAt),
          }
        : {
            id: null,
            title: "",
            body: "",
            category: "general",
            pinned: false,
            popupMode: "none",
            notifyByEmail: false,
            status: "published",
            publishAt: "",
          }
    )
    setAnnouncementOpen(true)
  }

  const handleSaveAnnouncement = async () => {
    if (!annDraft.title.trim() || !annDraft.body.trim()) return
    if (annDraft.status === "scheduled" && !annDraft.publishAt) {
      toast.error(t("adm.83"))
      return
    }
    setAnnouncementBusy(true)
    try {
      const payload = {
        title: annDraft.title,
        body: annDraft.body,
        category: annDraft.category,
        pinned: annDraft.pinned,
        popupMode: annDraft.popupMode,
        notifyByEmail: annDraft.notifyByEmail,
        status: annDraft.status,
        // 仅定时发布提交时间；其它状态传 null，避免残留脏值
        publishAt: annDraft.status === "scheduled" ? fromLocalInput(annDraft.publishAt) : null,
      }
      const res = annDraft.id
        ? await announcementApi.update(annDraft.id, payload)
        : await announcementApi.create(payload)
      // 邮件已入队、后台分批发送：这里只说「已排入队列」，真实进度看列表里的
      // 「推送中 x/y」标记（loadAnnouncements 会刷新）
      if (res.queued) {
        toast.success(t("adm.936", { v0: res.queued }))
      } else if (annDraft.status === "draft") {
        toast.success(t("adm.84"))
      } else if (annDraft.status === "scheduled") {
        toast.success(t("adm.937", { v0: new Date(fromLocalInput(annDraft.publishAt)!).toLocaleString("zh-CN") }))
      } else {
        toast.success(annDraft.id ? t("adm.85") : t("adm.86"))
      }
      setAnnouncementOpen(false)
      void loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.87"))
    } finally {
      setAnnouncementBusy(false)
    }
  }

  const handleDeleteAnnouncement = async (id: string) => {
    try {
      await announcementApi.remove(id)
      void loadAnnouncements()
      toast.success(t("adm.88"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.89"))
    }
  }

  /**
   * 重发某条公告里发送失败的邮件。
   *
   * 服务端只重置 failed 行、并校正计数，然后照常分批发送（走的是和首次群发
   * 完全相同的那条通道链），所以发送期间列表会显示「推送中 x/y」。
   */
  const handleResendAnnouncementMails = async (a: Announcement) => {
    try {
      const res = await announcementApi.resendFailed(a.id)
      if (res.requeued === 0) {
        toast.info(t("adm.90"))
      } else {
        toast.success(t("adm.938", { v0: res.requeued }))
      }
      void loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.91"))
    }
  }

  // ---- 活动 ----
  const loadEvents = React.useCallback(async () => {
    setEventLoading(true)
    try {
      const res = await adminEventApi.list()
      setEvents(res.events)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.92"))
    } finally {
      setEventLoading(false)
    }
  }, [])

  const openEventDialog = (ev?: EventItem) => {
    setEventDraft(
      ev
        ? {
            id: ev.id,
            title: ev.title,
            body: ev.body,
            status: ev.status,
            startsAt: toLocalInput(ev.startsAt),
            endsAt: toLocalInput(ev.endsAt),
            rewardLabel: ev.rewardLabel ?? "",
            rewardType: ev.rewardType,
            rewardAmount: String(ev.rewardParams?.amount ?? ev.rewardParams?.count ?? ""),
            // 「区间随机」的判据就是存了 min/max（老配置只有 amount）
            pointsRandom:
              ev.rewardParams?.min !== undefined || ev.rewardParams?.max !== undefined,
            rewardMin: String(ev.rewardParams?.min ?? ""),
            rewardMax: String(ev.rewardParams?.max ?? ""),
            conditionType: ev.conditionType,
            conditionFeature: String(ev.conditionParams?.feature ?? "ai"),
            conditionCode: String(ev.conditionParams?.code ?? ""),
            conditionRepo: String(ev.conditionParams?.repo ?? "Doulor/DoulorCloud"),
            lotteryWinners: String(ev.conditionParams?.winners ?? "10"),
            lotteryPool: String(ev.conditionParams?.pool ?? "1000"),
            lotteryMode: ev.conditionParams?.mode === "random" ? "random" : "even",
            // 投票选项：把库里的 {id,label,desc,image} 灌回草稿（保留原 id，见 helper 注释）
            quizMode: ev.conditionType === "quiz" || ev.conditionParams?.mode === "quiz",
            quizJson:
              ev.conditionType === "quiz" || ev.conditionParams?.mode === "quiz"
                ? JSON.stringify(ev.conditionParams, null, 2)
                : "",
            voteOptions: voteOptionsFromParams(ev.conditionParams),
            voteRule: parseVoteRule(ev.conditionParams?.rewardRule),
            voteFixedOptionId: String(ev.conditionParams?.fixedOptionId ?? ""),
            promoHidden: ev.promoHidden === true,
            maxClaims: ev.maxClaims != null ? String(ev.maxClaims) : "",
            publishAt: toLocalInput(ev.publishAt),
          }
        : emptyEventDraft()
    )
    setEventOpen(true)
  }

  const handleSaveEvent = async () => {
    if (!eventDraft.title.trim() || !eventDraft.body.trim()) {
      toast.error(t("adm.93"))
      return
    }
    if (eventDraft.status === "scheduled" && !eventDraft.publishAt) {
      toast.error(t("adm.94"))
      return
    }
    if (eventDraft.maxClaims.trim() !== "" && !(Number(eventDraft.maxClaims) >= 1)) {
      toast.error(t("adm.95"))
      return
    }
    /**
     * 问卷：JSON 必须能解析，且形状基本正确。
     * ⚠️ 这里只做「能解析 + 关键字段在」的粗校验 —— 真正的规则（选项≥2、正确答案必须在选项里、
     * 分档非空…）由服务端 parseQuizConfig 把关，前端重复实现一套只会两边不一致。
     */
    if (
      eventDraft.conditionType === "quiz" ||
      (eventDraft.conditionType === "vote" && eventDraft.quizMode)
    ) {
      try {
        const parsed = JSON.parse(eventDraft.quizJson) as {
          questions?: unknown[]
          scoring?: unknown
        }
        if (!Array.isArray(parsed.questions) || !parsed.questions.length) {
          toast.error(t("quiz.adm.errQuestions"))
          return
        }
        if (!parsed.scoring) {
          toast.error(t("quiz.adm.errScoring"))
          return
        }
      } catch {
        toast.error(t("quiz.adm.errJson"))
        return
      }
    }
    // 投票：至少 2 个填了标题的选项（后端也会拒，这里先给明确提示免得白跑一次）
    if (eventDraft.conditionType === "vote" && !eventDraft.quizMode) {
      const filled = eventDraft.voteOptions.filter((o) => o.label.trim())
      if (filled.length < 2) {
        toast.error(t("vote.adm.errNeedTwo"))
        return
      }
      // 「指定选项获奖」必须真的选一个 —— 漏了后端会 400，但错误信息不如这里直白
      if (
        isFixedVoteRule(eventDraft.voteRule) &&
        !filled.some((o) => o.key === eventDraft.voteFixedOptionId)
      ) {
        toast.error(t("vote.adm.errFixedOption"))
        return
      }
    }
    setEventBusy(true)
    try {
      const payload = eventDraftToPayload(eventDraft)
      const res = eventDraft.id
        ? await adminEventApi.update(eventDraft.id, payload)
        : await adminEventApi.create(payload)
      toast.success(
        eventDraft.id
          ? t("adm.96")
          : res.inserted > 0
            ? t("adm.939", { v0: res.inserted })
            : t("adm.97")
      )
      setEventOpen(false)
      void loadEvents()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.98"))
    } finally {
      setEventBusy(false)
    }
  }

  const handleDeleteEvent = async (ev: EventItem) => {
    if (!confirm(t("adm.940", { v0: ev.title }))) return
    try {
      await adminEventApi.remove(ev.id)
      void loadEvents()
      toast.success(t("adm.99"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.100"))
    }
  }

  /** 开奖（抽奖 / 多数少数得奖的投票共用）：二次确认后调接口（不可撤销，且真发奖励） */
  const handleDrawEvent = async (ev: EventItem) => {
    const l = ev.lottery
    const voteDraw = ev.vote && needsDrawForVote(ev.vote.rewardRule)
    // 既不是抽奖、也不是「要开奖」的投票 → 没有可开的奖（后端也会拒）
    if (!l && !voteDraw) return
    const summary = voteDraw
      ? t("adm.voteDrawConfirm", {
          v0: ev.title,
          v1: voteTotal(ev),
          v2: ev.vote?.options.length ?? 0,
        })
      : t("adm.941", { v0: ev.title, v1: ev.claimCount ?? 0 }) +
        t("adm.942", { v0: Math.min(l!.winners, ev.claimCount ?? 0) }) +
        t("adm.943", { v0: l!.pool, v1: l!.mode === "even" ? t("adm.944") : t("adm.945") })
    if (!confirm(summary + t("adm.946"))) {
      return
    }
    setEventBusy(true)
    try {
      const res = await adminEventApi.draw(ev.id)
      // 投票还会回报「哪个选项获奖」（平票时是多个），对站长是关键信息
      const winning =
        voteDraw && res.winningOptions?.length
          ? t("adm.voteDrawWinners", {
              v0: res.winningOptions
                .map(
                  (id) =>
                    ev.vote?.options.find((o) => o.id === id)?.label ?? id
                )
                .join(" / "),
            })
          : ""
      toast.success(
        t("adm.947", { v0: res.participants, v1: res.winners, v2: res.distributed }) +
          winning +
          (res.failed > 0 ? t("adm.948", { v0: res.failed }) : "")
      )
      void loadEvents()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.101"))
    } finally {
      setEventBusy(false)
    }
  }

  /**
   * 上传投票选项配图（管理员接口，存 events/ 前缀）。
   *
   * 校验放在前端只是为了快速反馈（格式 / 大小），服务端仍会再校验一遍
   * —— 前端不传图不代表后端可信，这里两处都要有。
   */
  const handleVoteImagePick = async (file: File | undefined) => {
    const target = voteImgTargetRef.current
    // 先清空，保证「同一个文件再选一次」也能触发 change（见 input 的注释）
    if (voteImgInputRef.current) voteImgInputRef.current.value = ""
    voteImgTargetRef.current = null
    if (!file || !target) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error(t("vote.adm.errImageFormat"))
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t("vote.adm.errImageSize"))
      return
    }
    setVoteImgUploading(target)
    try {
      const res = await adminEventApi.uploadImage(file)
      setEventDraft((d) => ({
        ...d,
        voteOptions: d.quizMode ? [] : d.voteOptions.map((o) =>
          o.key === target ? { ...o, image: res.url } : o
        ),
      }))
      toast.success(t("vote.adm.imageUploaded"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("vote.adm.errImageUpload"))
    } finally {
      setVoteImgUploading(null)
    }
  }

  const openClaimsDialog = async (ev: EventItem) => {
    setClaimsEvent(ev)
    setClaimsOpen(true)
    setClaimsLoading(true)
    try {
      const res = await adminEventApi.claims(ev.id)
      setClaims(res.claims)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.102"))
      setClaims([])
    } finally {
      setClaimsLoading(false)
    }
  }

  /**

   * 删除一条领取记录（管理员）。⚠️ 只删记录，**不回收已发出的奖励** ——

   * 所以二次确认里把这点写清楚，避免误删已到账的人。

   */

  /**
   * 删除一条领取记录（管理员）。⚠️ 只删记录，**不回收已发出的奖励** ——
   * 二次确认里把这点写清楚，避免误删已到账的人。
   */
  const handleDeleteClaim = async (claim: EventClaim) => {
    if (!claimsEvent) return
    if (!window.confirm(t("adm.claimDeleteConfirm", { user: claim.username ?? "" }))) return
    try {
      await adminEventApi.deleteClaim(claimsEvent.id, claim.id)
      toast.success(t("adm.claimDeleted"))
      const res = await adminEventApi.claims(claimsEvent.id)
      setClaims(res.claims)
      notifyAttentionChanged() // 活动角标当场减一
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.104"))
    }
  }


  const handleGrantClaim = async (claim: EventClaim) => {
    if (!claimsEvent) return
    try {
      await adminEventApi.grant(claimsEvent.id, claim.id)
      toast.success(t("adm.103"))
      const res = await adminEventApi.claims(claimsEvent.id)
      setClaims(res.claims)
      notifyAttentionChanged() // 活动角标当场减一，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.104"))
    }
  }

  // 2026-10-08：搜索已改服务端（后端按用户名/邮箱/命名空间同口径过滤），
  // 这里不再做本地过滤 —— 旧写法在全量数据上过滤，分页后会对「当前页」重复过滤，
  // 口径一致所以结果相同，纯属浪费，删掉。
  const filtered = users

  // 用户邀请码列表的搜索（用户名 / 邮箱 / 域名），与用户列表同口径
  const quotaUsers = (inviteQuotas?.users ?? []).filter((u) =>
    (u.username + u.email + u.namespace)
      .toLowerCase()
      .includes(quotaFilter.trim().toLowerCase())
  )

  const openDetail = async (username: string) => {
    setBusy(true)
    try {
      const res = await adminApi.getUser(username)
      setDetail(res)
      setNickDraft(res.user.nickname ?? "")
      setDetailUser(username)
      // 「最近活动」懒加载状态随详情一起重置：首屏正好 20 条时大概率还有下一页
      setActivityExtra([])
      setActivityHasMore(res.activity.length >= 20)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.125"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 打开邀请码溯源弹窗。`idOrCode` 同时接受**邀请码 id** 和**码字符串**
   * （用户列表里只存了码，点码即查，不必先换成 id）。
   */
  const openInviteTrace = async (idOrCode: string) => {
    setTraceCode(idOrCode)
    setTraceData(null)
    setTraceBusy(true)
    try {
      setTraceData(await adminApi.traceInvite(idOrCode))
    } catch (err) {
      // 拉不到（码已删 / 网络问题）就关掉弹窗，只留 toast，别卡在「正在加载」
      setTraceCode(null)
      setTraceData(null)
      toast.error(err instanceof HttpError ? err.message : t("adm.1284"))
    } finally {
      setTraceBusy(false)
    }
  }

  /** 「最近活动」加载更多：offset = 首屏条数 + 已追加条数 */
  const loadMoreActivity = async () => {
    if (!detail || activityBusy) return
    setActivityBusy(true)
    try {
      const res = await adminApi.getUserActivity(
        detail.user.username,
        detail.activity.length + activityExtra.length
      )
      setActivityExtra((prev) => [...prev, ...res.activity])
      setActivityHasMore(res.hasMore)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.1285"))
    } finally {
      setActivityBusy(false)
    }
  }

  /** 保存昵称（留空 = 清空）；与用户自助改名共用同一套后端校验 */
  const handleSaveNickname = async () => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, {
        nickname: nickDraft.trim() === "" ? null : nickDraft.trim(),
      })
      setDetail(res)
      toast.success(nickDraft.trim() === "" ? t("adm.126") : t("adm.127"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.128"))
    } finally {
      setBusy(false)
    }
  }

  /** 切换邮箱验证 / 通知开关 */
  const handleToggleUserFlag = async (
    field: "emailVerified" | "notifyEnabled",
    value: boolean
  ) => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, { [field]: value })
      setDetail(res)
      const label = field === "emailVerified" ? t("adm.969") : t("adm.970")
      toast.success(t("adm.971", { v0: label, v1: value ? t("adm.134") : t("adm.135") }))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.136"))
    } finally {
      setBusy(false)
    }
  }

  /** 切换角色（admin / user）；主管理员在后端被拒 */
  const handleToggleRole = async (nextRole: "admin" | "user") => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, { role: nextRole })
      setDetail(res)
      toast.success(nextRole === "admin" ? t("adm.137") : t("adm.138"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.139"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 调整会员等级（2026-11-06）：运营兜底，允许下调（用户侧不可降）。
   * 常规升级走用户自己的「积分」页（消耗积分），这里只处理补偿 / 纠错。
   */
  const handleSetMemberLevel = async (lv: number) => {
    if (!detail) return
    const cur = detail.user.memberLevel ?? 0
    if (lv === cur) return
    if (lv < cur) {
      const ok = await confirmDialog({
        title: t("adm.level.confirmDown", {
          name: detail.user.username,
          from: t(`lvl.${cur}`),
          to: t(`lvl.${lv}`),
        }),
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, { memberLevel: lv })
      setDetail(res)
      toast.success(t("adm.level.toast", { name: detail.user.username, to: t(`lvl.${lv}`) }))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.136"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 重置某个用户的二次认证 —— **最后一道保险**。
   *
   * 场景：管理员手机丢了 / 认证器删了，密码还记得但被 2FA 挡在门外。
   * 这是唯一能把他救回来的手段，所以只能由 root 做 ——
   * admin 之间互相拆锁等于这道锁可以被内部人绕过。
   *
   * 刻意做成「先确认再执行」：清掉之后对方会退化成「只有密码」的状态，
   * 万一他是被钓鱼骗着点的，损失会很大。
   */
  /**
   * 重置密码（rootOnly）：给当前查看的用户直接设一个新密码。
   * 后端会哈希入库并清空该用户全部会话 / OAuth 令牌。
   */
  const handleSetPassword = async () => {
    if (!detail || pwBusy) return
    const name = detail.user.username
    if (pwValue.length < 8) {
      toast.error(t("adm.pw.tooShort"))
      return
    }
    setPwBusy(true)
    try {
      await adminApi.setUserPassword(name, pwValue)
      toast.success(t("adm.pw.ok", { v0: name }))
      setPwOpen(false)
      setPwValue("")
      setPwShow(false)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.pw.failed"))
    } finally {
      setPwBusy(false)
    }
  }

  const handleResetTwoFactor = async () => {
    if (!detail) return
    const name = detail.user.username
    const ok = await confirmDialog({
      title: t("adm.1255", { v0: name }),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await twoFactorApi.adminReset(detail.user.id)
      toast.success(t("adm.1256", { v0: name }))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.1257"))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatusByName = async (username: string, currentStatus: string) => {
    // 封禁：弹正式对话框写原因（多行备注）；解封不需要原因（后端会自动清掉旧原因）。
    if (currentStatus !== "suspended") {
      setSuspendTarget({ username, status: currentStatus })
      setSuspendReasonText("")
      return
    }
    await doToggleStatus(username, "suspended")
  }

  const doToggleStatus = async (
    username: string,
    currentStatus: string,
    suspendReason?: string
  ) => {
    setBusy(true)
    try {
      const res = await adminApi.updateUser(username, {
        status: currentStatus === "suspended" ? "active" : "suspended",
        ...(suspendReason ? { suspendReason } : {}),
      })
      setDetail(res)
      toast.success(res.user.status === "suspended" ? t("adm.140") : t("adm.141"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.142"))
    } finally {
      setBusy(false)
    }
  }

  
  /** 切换某用户的功能权限（管理员在成员详情里调整） */
  const handleTogglePermission = async (key: FeatureKey, value: boolean) => {
    if (!detail) return
    setBusy(true)
    try {
      const nextPerms = { ...detail.user.permissions, [key]: value }
      const res = await adminApi.updateUser(detail.user.username, {
        permissions: nextPerms,
      })
      setDetail(res)
      toast.success(
        t("adm.975", { v0: t(FEATURE_LABELS[key]), v1: value ? t("adm.976") : t("adm.977") })
      )
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.144"))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatus = (u: AdminUser) =>
    handleToggleStatusByName(u.username, u.status)

  const handleDelete = async (u: AdminUser) => {
    setBusy(true)
    try {
      await adminApi.deleteUser(u.username)
      toast.success(t("adm.145"))
      setDetail(null)
      setDetailUser("")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.146"))
    } finally {
      setBusy(false)
    }
  }

  const openMessage = async (messageId: string) => {
    if (!detailUser) return
    try {
      const res = await adminApi.getUserMessage(detailUser, messageId)
      setOpenedMessage(res.message)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.147"))
    }
  }

  /**
   * 拉取各栏目「待处理」角标（反馈 / 捐献 / 积分），与侧边栏「管理」总角标同源。
   *
   * 依赖 `activeTab`：管理员处理完一批事通常会切走，切 tab 顺手重取一次，
   * 不必等下一次轮询；60 秒轮询是兜底，让「处理完一条角标自己减一」也能生效。
   */
  React.useEffect(() => {
    let cancelled = false
    const tick = () => {
      attentionApi
        .get()
        .then((r) => !cancelled && setAttention(r.admin))
        .catch(() => {})
    }
    tick()
    const t = setInterval(() => {
      if (!document.hidden) tick()
    }, 60_000)
    // 处理完一条待办后立即重拉（见 confirmReview / handleGrantClaim；
    // 反馈与积分的处理在各自子组件里，也会广播同一事件）
    const off = onAttentionChanged(tick)
    return () => {
      cancelled = true
      clearInterval(t)
      off()
    }
  }, [activeTab])

  // 加载权限树 + 当前管理员权限（侧边栏过滤用；root/superadmin 恒看全部，不拉）
  React.useEffect(() => {
    const isPrivileged = user?.role === "root" || user?.role === "superadmin"
    if (isPrivileged) {
      setMyScope(null)
      setSidebarOnlyPermitted(false)
      return
    }
    let cancelled = false
    adminApi
      .getPermissionTree()
      .then((r) => {
        if (cancelled) return
        setPermCategories(r.categories)
        setMyScope(new Set(r.myScope))
        setSidebarOnlyPermitted(r.sidebarOnlyPermitted)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user?.role])

  /**
   * 当前管理员能否看到某个侧边栏栏目。
   * root/superadmin 恒可见；admin 在「只显示有权限的栏目」开启时，
   * 只有该栏目对应大类下有任意一个叶子权限在自身白名单里才可见。
   */
  const canSeeTab = (tabKey: string): boolean => {
    if (myScope === null) return true // 全权，或尚未加载
    if (!sidebarOnlyPermitted) return true
    const cat = permCategories.find((c) => c.key === tabKey)
    if (!cat) return true // 无映射的栏目（如权限管理）交给别处的角色判断
    const leaves = cat.children?.map((l) => l.key) ?? [cat.key]
    return leaves.some((k) => myScope.has(k))
  }

  /** 切换管理面板 tab：切到对应标签时懒加载该标签的数据 */
  const handleTabChange = (v: string) => {
    // 切栏目 = 换路由；数据加载统一由下面的 useEffect 按 activeTab 触发
    navigate(`/admin/${v}`)
  }

  /** 按栏目懒加载数据（初始直达 / 后退 / 前进时也要跑，所以挂在 useEffect 上） */
  const loadForTab = (v: string) => {
    if (v === "invites") void loadInvites()
    if (v === "settings") void loadSettings()
    if (v === "reserved") void loadNickReserved()
    if (v === "announcements") void loadAnnouncements()
    if (v === "events") void loadEvents()
    if (v === "inviteQuotas") void loadInviteQuotas()
    if (v === "community") void loadCommunity()
  }

  // 初始直达（/admin/invites 直接打开）与前进/后退都走这里：路由变了就按新栏目拉数据
  React.useEffect(() => {
    loadForTab(activeTab)
    // loadForTab 引用的加载函数都是本组件内的 useCallback/普通函数，
    // 依赖只需要 activeTab —— 变化即重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  return (
    <div>
      <PageHeader
        title={t("adm.213")}
        // ⚠️ 必须用服务端返回的 total，不能用 users.length —— 分页后那只是**当前页**
        // （50 条 + 20 条注销留痕 = 70），页面头部一度因此显示「已注册用户 70 个」。
        description={t("adm.978", {
          v0: userTotalAll ?? serverTotal ?? users.length,
          v1: inviteTotalAll ?? inviteTotal ?? invites.length,
        })}
      />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左侧二级导航：sticky 固定，右侧内容再长也能随时切栏目。
              「返回控制台」固定在最上，不随下方 nav 滚动 */}
          <aside className="flex w-full shrink-0 flex-col lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-48 lg:self-start">
            {/* 管理后台是独立 SPA：回主站必须整页跳转，客户端路由到不了另一个入口 */}
            <a
              href="/"
              className="mb-3 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("adm.326")}
            </a>

            <nav className="flex flex-col gap-0.5 lg:overflow-y-auto lg:pr-1">
              {/* 动效层：栏目切换的滑动高亮（关=现状：关掉时滑块不渲染，
                  NavItem 自己的 active 背景在 CSS 侧被还回来） */}
              <SlidingPill
                activeSelector='[data-nav-active="1"]'
                className="rounded-md bg-accent"
              />
              {/* 网站统计放常驻顶部（站长 2026-10-25 要求：高频入口不藏在分组里） */}
              {canSeeTab("analytics") && (
                <NavItem active={activeTab === "analytics"} icon={BarChart3} label={t("adm.236")} onClick={() => handleTabChange("analytics")} />
              )}
              <NavGroup label={t("adm.215")} open={groupOpen("adm.215")} onToggle={() => toggleGroup("adm.215")}>
                {canSeeTab("users") && (
                  <NavItem active={activeTab === "users"} icon={Users} label={t("adm.214")} onClick={() => handleTabChange("users")} />
                )}
                {canSeeTab("invites") && <NavItem active={activeTab === "invites"} icon={KeyRound} label={t("adm.216")} onClick={() => handleTabChange("invites")} />}
                {canSeeTab("inviteQuotas") && <NavItem active={activeTab === "inviteQuotas"} icon={Ticket} label={t("adm.217")} onClick={() => handleTabChange("inviteQuotas")} />}
                {canSeeTab("reserved") && <NavItem active={activeTab === "reserved"} icon={ShieldBan} label={t("adm.218")} onClick={() => handleTabChange("reserved")} />}
                {canSeeTab("titles") && <NavItem active={activeTab === "titles"} icon={Medal} label={t("adm.219")} onClick={() => handleTabChange("titles")} />}
                {/* 监管：风险账户（自动扫描）+ 封禁申诉；后续风控规则都归这里。
                    角标只数**封禁申诉** —— 风险账户是自动观察名单，没人处理也不该
                    一直挂着角标（站长要求），否则这个数永远不归零。 */}
                {canSeeTab("moderation") && (
                  <NavItem
                    active={activeTab === "moderation"}
                    icon={ShieldAlert}
                    label={t("adm.moderation")}
                    count={attention?.appeals}
                    onClick={() => handleTabChange("moderation")}
                  />
                )}
                {/* 通知：站长给单个/多个用户发强制已读通知，可选确认前禁用权限 */}
                {canSeeTab("notices") && (
                  <NavItem
                    active={activeTab === "notices"}
                    icon={Megaphone}
                    label={t("adm.notices")}
                    onClick={() => handleTabChange("notices")}
                  />
                )}
              </NavGroup>
              <NavGroup label={t("adm.226")} open={groupOpen("adm.226")} onToggle={() => toggleGroup("adm.226")}>
                {canSeeTab("announcements") && <NavItem active={activeTab === "announcements"} icon={Megaphone} label={t("adm.227")} onClick={() => handleTabChange("announcements")} />}
                {/* 角标 = 活动奖励里「自动发放失败、要人工发」的条数（见各活动的「领取名单」） */}
                {canSeeTab("events") && (
                  <NavItem
                    active={activeTab === "events"}
                    icon={PartyPopper}
                    label={t("adm.229")}
                    count={attention?.eventClaims}
                    onClick={() => handleTabChange("events")}
                  />
                )}
                {/* 「积分」角标 = 待审核商品（不含待处理订单 —— 2026-10-03 站长要求，
                    订单多是等卖家交付/买家确认的正常流程态，不该挂角标虚高） */}
                {canSeeTab("points") && (
                  <NavItem
                    active={activeTab === "points"}
                    icon={Coins}
                    label={t("adm.230")}
                    count={attention?.pointProducts ?? 0}
                    onClick={() => handleTabChange("points")}
                  />
                )}
                {canSeeTab("community") && <NavItem active={activeTab === "community"} icon={MessagesSquare} label={t("adm.231")} onClick={() => handleTabChange("community")} />}
                {canSeeTab("feedback") && (
                  <NavItem
                    active={activeTab === "feedback"}
                    icon={MessageSquare}
                    label={t("adm.233")}
                    count={attention?.feedback}
                    onClick={() => handleTabChange("feedback")}
                  />
                )}
              </NavGroup>
              <NavGroup label={t("adm.234")} open={groupOpen("adm.234")} onToggle={() => toggleGroup("adm.234")}>
                {canSeeTab("oauth") && <NavItem active={activeTab === "oauth"} icon={KeyRound} label={t("adm.235")} onClick={() => handleTabChange("oauth")} />}
                {canSeeTab("cfQuota") && <NavItem active={activeTab === "cfQuota"} icon={Gauge} label={t("adm.237")} onClick={() => handleTabChange("cfQuota")} />}
                {canSeeTab("perf") && <NavItem active={activeTab === "perf"} icon={Activity} label={t("perf.tab")} onClick={() => handleTabChange("perf")} />}
                {canSeeTab("audit") && <NavItem active={activeTab === "audit"} icon={ScrollText} label={t("adm.238")} onClick={() => handleTabChange("audit")} />}
                {canSeeTab("settings") && <NavItem active={activeTab === "settings"} icon={SlidersHorizontal} label={t("adm.240")} onClick={() => handleTabChange("settings")} />}
                {/* 权限管理：只有 root / superadmin 能进（后端守卫一致） */}
                {(user?.role === "root" || user?.role === "superadmin") && (
                  <NavItem active={activeTab === "permissions"} icon={ShieldCheck} label={t("adm.perm.tab")} onClick={() => handleTabChange("permissions")} />
                )}
              </NavGroup>
            </nav>
          </aside>

          {/* 右侧内容区 */}
          <div className="min-w-0 flex-1">
        <TabsContent value="users">
          <div className="sticky top-4 z-20 -mx-1 mb-3 flex items-center gap-2 bg-background px-1 pb-1">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("adm.241")}
                className="pl-8"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {/* 「注册 IP」列的显示开关（默认隐藏，需要时再打开） */}
            <Button
              variant={showRegisterIp ? "default" : "outline"}
              size="sm"
              className="shrink-0"
              onClick={() => setShowRegisterIp((v) => !v)}
              title={t("adm.registerIp")}
            >
              {showRegisterIp ? (
                <EyeOff className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Eye className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("adm.registerIp")}
            </Button>
            {/* 多选模式：常驻只有一个「编辑」按钮，点它才出现行勾选框与批量操作 */}
            <Button
              size="sm"
              variant={selectMode ? "default" : "outline"}
              className="shrink-0"
              onClick={() => {
                const next = !selectMode
                setSelectMode(next)
                if (!next) setSelectedUserIds(new Set())
              }}
            >
              {selectMode ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
              )}
              {selectMode ? t("adm.sel.done") : t("adm.sel.edit")}
            </Button>
            {selectMode && selectedUserIds.size > 0 && (
              <>
                <Badge variant="secondary" className="shrink-0">
                  {t("adm.sel.selected", { n: String(selectedUserIds.size) })}
                </Badge>
                <Button
                  size="sm"
                  variant="destructive"
                  className="shrink-0"
                  onClick={() => {
                    setBulkReason("")
                    setBulkAction("suspend")
                  }}
                >
                  <Ban className="mr-1.5 h-3.5 w-3.5" />
                  {t("adm.sel.suspend")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setBulkAction("unsuspend")}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  {t("adm.sel.unsuspend")}
                </Button>
              </>
            )}
          </div>

      {loading ? (
        <AdminUsersSkeleton withRegisterIp={showRegisterIp} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t("adm.242")} description={t("adm.243")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table wrapperClassName="overflow-x-auto lg:overflow-clip">
            <TableHeader>
              <TableRow>
                {/* 多选模式才有勾选列；**没有全选**（表头 deliberately 留空） */}
                {selectMode && (
                  <TableHead className="sticky top-[56px] z-10 w-10 border-b bg-card" />
                )}
                <TableHead className="sticky top-[56px] z-10 w-16 border-b bg-card">UID</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.327")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.328")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.329")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">
                  {t("adm.level.col")}
                </TableHead>
                {showRegisterIp && (
                  <TableHead className="sticky top-[56px] z-10 border-b bg-card">
                    {t("adm.registerIp")}
                  </TableHead>
                )}
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.335")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 w-24 border-b bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) =>
                u.deleted ? (
                  // 已注销/被删用户：留痕行，只读展示，无可执行操作
                  <TableRow key={u.id} className="text-muted-foreground">
                    <TableCell className="font-mono text-xs">
                      {u.uid != null ? fmtUid(u.uid) : "—"}
                    </TableCell>
                    <TableCell colSpan={selectMode ? 9 : 8}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm line-through">{u.username}</span>
                        <span className="text-xs">{u.email}</span>
                        <Badge variant="outline">{t("adm.336")}</Badge>
                        {u.deletedReason === "admin" && (
                          <Badge variant="destructive">{t("adm.337")}</Badge>
                        )}
                        <span className="text-xs">{t("adm.979", { v0: u.deletedAt ? fmtTime(u.deletedAt) : t("adm.148") })}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                <TableRow key={u.id}>
                  {selectMode && (
                    <TableCell className="w-10 align-top">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary"
                        checked={selectedUserIds.has(u.id)}
                        onChange={(e) => {
                          setSelectedUserIds((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(u.id)
                            else next.delete(u.id)
                            return next
                          })
                        }}
                        aria-label={u.username}
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {u.uid != null ? fmtUid(u.uid) : "—"}
                  </TableCell>
                  {/* 用户名/邮箱列：**固定宽度**。
                      原先用 max-w-[260px] 无效 —— 表格单元格的 max-width 不可靠，
                      个别超长邮箱仍会把整列撑开、吃掉右侧操作列的空间（站长 2026-10-03 反馈）。
                      改成固定宽的内层块，truncate 才真的生效：大部分人邮箱能完整显示，
                      个别超长的截断，hover 看全文。 */}
                  <TableCell>
                    <button
                      type="button"
                      className="block w-[170px] text-left hover:underline"
                      onClick={() => void openDetail(u.username)}
                    >
                      <p className="truncate font-mono text-sm" title={u.username}>
                        {u.username}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" title={u.email}>
                        {u.email}
                      </p>
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {u.inviteCode ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="font-mono text-xs text-primary hover:underline"
                              onClick={() => void openInviteTrace(u.inviteCode!)}
                            >
                              {u.inviteCode}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t("adm.980", { v0: u.inviteCreatedBy ?? t("adm.981") })}</p>
                            <p className="text-muted-foreground">
                              {u.inviteCreatedAt
                                ? fmtTime(u.inviteCreatedAt)
                                : t("adm.149")}
                            </p>
                            <p className="mt-1 text-primary">{t("adm.1287")}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtTime(u.createdAt)}
                  </TableCell>
                  {/* 注册 IP：默认隐藏（见 showRegisterIp 开关）。固定宽度 + 截断，避免长 IPv6 撑宽整列 */}
                  {showRegisterIp && (
                    <TableCell className="text-xs text-muted-foreground">
                      {u.registerIp ? (
                        <span
                          className="block w-[110px] truncate font-mono"
                          title={u.registerIp}
                        >
                          {u.registerIp}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {(u.memberLevel ?? 0) > 0 ? (
                      <Badge variant="outline" className="border-amber-500 text-amber-600">
                        {t(`lvl.${u.memberLevel}`)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("lvl.0")}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.status === "active" ? (
                      <Badge variant="success">active</Badge>
                    ) : (
                      <Badge variant="destructive">suspended</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        asChild
                        title={t("adm.245")}
                      >
                        <a href={`/space/${encodeURIComponent(u.username)}`}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={() => void openDetail(u.username)}
                        disabled={busy}
                        title={t("adm.246")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t("adm.338")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        onClick={() => void handleToggleStatus(u)}
                        disabled={busy || u.username === user?.username}
                        title={u.status === "active" ? t("adm.982") : t("adm.983")}
                      >
                        {u.status === "active" ? (
                          <Ban className="h-4 w-4" />
                        ) : (
                          <UserCheck className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDelete(u)}
                        disabled={busy || u.username === user?.username}
                        title={t("adm.247")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 服务端分页控件（2026-10-08）：总数/页码来自接口，翻页即拉对应页 */}
      {!loading && serverTotal != null && serverTotal > USER_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t("adm.userPageInfo", {
              from: userPage * USER_PAGE_SIZE + 1,
              to: Math.min((userPage + 1) * USER_PAGE_SIZE, serverTotal),
              total: serverTotal,
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={userPage === 0}
              onClick={() => setUserPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("adm.userPagePrev")}
            </Button>
            <span className="tabular-nums">
              {userPage + 1} / {Math.ceil(serverTotal / USER_PAGE_SIZE)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(userPage + 1) * USER_PAGE_SIZE >= serverTotal}
              onClick={() => setUserPage((p) => p + 1)}
            >
              {t("adm.userPageNext")}
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* 会员银行卡靓号池：预留的号不会被自动分配，只能从用户详情里发放 */}
      <AdminCardNumbersCard />
        </TabsContent>

        <TabsContent value="invites">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.339")}
            </p>
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("adm.340")}
            </Button>
          </div>

          {/* 分类筛选：数字是各分类的条数 */}
          <div className="mb-4 flex flex-wrap gap-2">
            {INVITE_FILTERS.map((f) => {
              const n = inviteCounts?.[f.key] ?? (f.key === "" ? invites.length : filterInvites(invites, f.key).length)
              const active = inviteFilter === f.key
              return (
                <Button
                  key={f.key || "all"}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => {
                    setInviteFilter(f.key)
                    // 换分类回第一页（React 自动批处理，下面的 effect 只会跑一次）
                    setInvitePage(0)
                  }}
                >
                  {t(f.label)}
                  <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
                </Button>
              )
            })}
          </div>

          {inviteLoading ? (
            <AdminInvitesSkeleton />
          ) : invites.length === 0 ? (
            // 服务端筛选后为空要分清两种情况：全站一个码都没有 vs 只是该分类没有。
            // counts[""] 是「全部」的总数（GROUP BY 带出），有它就能区分。
            (inviteCounts?.[""] ?? 0) === 0 ? (
              <EmptyState title={t("adm.248")} description={t("adm.249")} />
            ) : (
              <EmptyState
                title={t("adm.984", { v0: t(INVITE_FILTERS.find((f) => f.key === inviteFilter)?.label ?? "") })}
                description={t("adm.250")}
              />
            )
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adm.341")}</TableHead>
                    <TableHead>{t("adm.342")}</TableHead>
                    <TableHead>{t("adm.343")}</TableHead>
                    <TableHead>{t("adm.344")}</TableHead>
                    <TableHead>{t("adm.345")}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((inv) => {
                    const exhausted = inv.usedCount >= inv.maxUses
                    const expired =
                      inv.expiresAt !== null &&
                      new Date(inv.expiresAt).getTime() < Date.now()
                    return (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-sm">
                          <button
                            type="button"
                            className="font-mono text-sm text-primary hover:underline"
                            onClick={() => void openInviteTrace(inv.code)}
                            title={t("adm.1288")}
                          >
                            {inv.code}
                          </button>
                        </TableCell>
                        <TableCell>
                          {inv.usedCount} / {inv.maxUses}
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            className="flex flex-wrap gap-1 text-left"
                            onClick={() => openInvitePerms(inv)}
                            title={t("adm.251")}
                          >
                            {FEATURES.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : FEATURES.filter((f) => inv.permissions[f.key]).length ===
                            FEATURES.length ? (
                              <Badge variant="secondary">{t("adm.346")}</Badge>
                            ) : FEATURES.filter((f) => inv.permissions[f.key]).length ===
                              0 ? (
                              <Badge variant="destructive">{t("adm.347")}</Badge>
                            ) : (
                              FEATURES.filter((f) => inv.permissions[f.key]).map((f) => (
                                <Badge key={f.key} variant="outline">
                                  {t(f.label)}
                                </Badge>
                              ))
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTime(inv.createdAt)}
                        </TableCell>
                        <TableCell>
                          {exhausted ? (
                            <Badge variant="destructive">{t("adm.348")}</Badge>
                          ) : expired ? (
                            <Badge variant="destructive">{t("adm.349")}</Badge>
                          ) : (
                            <Badge variant="success">{t("adm.350")}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => void openInviteTrace(inv.code)}
                              title={t("adm.1288")}
                            >
                              <Network className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => openInvitePerms(inv)}
                              title={t("adm.252")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDeleteInvite(inv)}
                              title={t("adm.253")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* 服务端分页控件（2026-10-08，与用户/捐献列表同款） */}
          {!inviteLoading && inviteTotal != null && inviteTotal > INVITE_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t("adm.userPageInfo", {
                  from: invitePage * INVITE_PAGE_SIZE + 1,
                  to: Math.min((invitePage + 1) * INVITE_PAGE_SIZE, inviteTotal),
                  total: inviteTotal,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={invitePage === 0}
                  onClick={() => setInvitePage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                  {t("adm.userPagePrev")}
                </Button>
                <span className="tabular-nums">
                  {invitePage + 1} / {Math.ceil(inviteTotal / INVITE_PAGE_SIZE)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(invitePage + 1) * INVITE_PAGE_SIZE >= inviteTotal}
                  onClick={() => setInvitePage((p) => p + 1)}
                >
                  {t("adm.userPageNext")}
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="inviteQuotas">
          <p className="mb-4 text-sm text-muted-foreground">{t("adm.1007", { v0: inviteQuotas?.baseQuota ?? 3, v1: t("adm.377"), v2: t("adm.378") })}</p>

          {/* 顶部搜索：与用户列表同款，按用户名 / 邮箱 / 域名过滤 */}
          <div className="relative mb-3 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("adm.259")}
              className="pl-8"
              value={quotaFilter}
              onChange={(e) => setQuotaFilter(e.target.value)}
            />
          </div>

          {inviteQuotaLoading ? (
            <LoadingBlock variant="table" />
          ) : (inviteQuotas?.users.length ?? 0) === 0 ? (
            <EmptyState title={t("adm.260")} description={t("adm.261")} />
          ) : quotaUsers.length === 0 ? (
            <EmptyState title={t("adm.262")} description={t("adm.263")} />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">UID</TableHead>
                    <TableHead>{t("adm.379")}</TableHead>
                    <TableHead>{t("adm.380")}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotaUsers.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {u.uid != null ? fmtUid(u.uid) : "—"}
                      </TableCell>
                      <TableCell>
                        <p className="font-mono text-sm">{u.username}</p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-semibold">{u.inviteRemaining}</span>
                        <span className="text-muted-foreground">
                          {" / "}
                          {u.inviteTotal}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">{t("adm.1008", { v0: u.inviteBase, v1: u.inviteBonus })}</span>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void openQuotaDetail(u.username)}
                        >
                          {t("adm.384")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="reserved">
          {/* 昵称保留词 */}
          <div className="mt-8 mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium">{t("adm.395")}</h3>
            <span className="text-xs text-muted-foreground">
              {t("adm.396")}
            </span>
          </div>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("adm.397")}
              {t("adm.398")}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="rnick" className="text-xs">{t("adm.399")}</Label>
                <Input
                  id="rnick"
                  placeholder={t("adm.268")}
                  className="w-40"
                  value={nickReservedInput}
                  onChange={(e) => setNickReservedInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void handleAddNickReserved()
                    }
                  }}
                />
              </div>
              <Button
                onClick={() => void handleAddNickReserved()}
                disabled={nickReservedBusy || !nickReservedInput.trim()}
              >
                {nickReservedBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Plus className="h-4 w-4" />
                {t("adm.400")}
              </Button>
            </div>
            {nickReserved.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {nickReserved.map((w) => (
                  <Badge
                    key={w}
                    variant="secondary"
                    className="gap-1 py-1 pl-2.5 pr-1.5"
                  >
                    <span className="font-mono">{w}</span>
                    <button
                      onClick={() => handleRemoveNickReserved(w)}
                      className="rounded-sm p-0.5 hover:bg-background hover:text-foreground"
                      aria-label={t("adm.1009", { v0: w })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("adm.401")}</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="feedback">
          <FeedbackPanel />
        </TabsContent>

        <TabsContent value="announcements">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.420")}
            </p>
            <Button size="sm" onClick={() => openAnnouncementDialog()}>
              <Plus className="h-4 w-4" />
              {t("adm.421")}
            </Button>
          </div>
          {announcementLoading ? (
            <LoadingBlock variant="list" />
          ) : announcements.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title={t("adm.275")}
              description={t("adm.276")}
            />
          ) : (
            <div className="space-y-3">
              {announcements.map((a) => (
                <Card key={a.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          {a.status === "draft" && <Badge variant="secondary">{t("adm.1028")}</Badge>}
                          {a.status === "scheduled" && (
                            <Badge variant="default" className="gap-1">
                              <Clock className="h-3 w-3" />{t("adm.1029", { v0: a.publishAt ? new Date(a.publishAt).toLocaleString("zh-CN") : "" })}</Badge>
                          )}
                          {a.pinned && <Badge variant="success">{t("adm.1030")}</Badge>}
                          <Badge variant="secondary">{a.category}</Badge>
                          {/* 邮件群发进度：推送中显示 x/y，完成后显示结果与失败数 */}
                          {a.mailStatus === "sending" && (
                            <Badge variant="default" className="tabular-nums">
                              <Loader2 className="h-3 w-3 animate-spin" />{t("adm.1031", { v0: a.mailSent, v1: a.mailTotal })}</Badge>
                          )}
                          {a.mailStatus === "done" && (
                            <Badge
                              variant={a.mailFailed > 0 ? "destructive" : "outline"}
                              className="tabular-nums"
                            >{t("adm.1032", { v0: a.mailSent, v1: a.mailTotal, v2: a.mailFailed > 0 ? t("adm.1033", { v0: a.mailFailed }) : "" })}</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {new Date(a.createdAt).toLocaleString("zh-CN")}
                          </span>
                        </div>
                        <p className="text-sm font-medium">{a.title}</p>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {a.body}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* 只有「已推送完且有失败」才给重发入口：推送中重复点会撞车，
                            失败重发是唯一有意义的场景 */}
                        {a.mailStatus === "done" && a.mailFailed > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => void handleResendAnnouncementMails(a)}
                          >
                            <RefreshCw className="h-3 w-3" />{t("adm.1034", { v0: a.mailFailed })}</Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openAnnouncementDialog(a)}
                          aria-label={t("adm.277")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteAnnouncement(a.id)}
                          aria-label={t("adm.278")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="titles">
          <TitlesAdminPanel />
        </TabsContent>

        <TabsContent value="moderation">
          <ModerationAdminPanel />
        </TabsContent>

        <TabsContent value="notices">
          <AdminNoticesPanel />
        </TabsContent>

        {/* 中转站入驻审核（审核制）：数据由面板自己加载，这里不需要懒加载钩子 */}

        <TabsContent value="events">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.422")}
            </p>
            <Button size="sm" onClick={() => openEventDialog()}>
              <Plus className="h-4 w-4" />
              {t("adm.423")}
            </Button>
          </div>
          {eventLoading ? (
            <LoadingBlock variant="list" />
          ) : events.length === 0 ? (
            <EmptyState
              icon={PartyPopper}
              title={t("adm.279")}
              description={t("adm.280")}
            />
          ) : (
            <div className="space-y-3">
              {events.map((ev) => (
                <Card key={ev.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={EVENT_STATUS_BADGE[ev.status]}>
                            {t(EVENT_STATUS_TEXT[ev.status])}
                          </Badge>
                          {ev.rewardLabel && <Badge variant="secondary">{ev.rewardLabel}</Badge>}
                          {ev.lottery && (
                            <Badge variant={ev.lottery.drawn ? "secondary" : "default"}>{t("adm.1035", { v0: ev.lottery.drawn ? t("adm.1036") : t("adm.1037"), v1: ev.lottery.winners, v2: ev.lottery.pool, v3: ev.lottery.mode === "even" ? t("adm.1038") : t("adm.1039") })}</Badge>
                          )}
                          {ev.vote && (
                            <Badge
                              variant={
                                // 「多数/少数得奖」要开奖，没开就标成待开（与抽奖同款视觉）
                                ev.vote.drawn || !needsDrawForVote(ev.vote.rewardRule)
                                  ? "secondary"
                                  : "default"
                              }
                            >
                              {t("adm.voteBadge", {
                                v0: t(VOTE_RULE_LABEL_KEY[ev.vote.rewardRule]),
                                v1: ev.vote.options.length,
                                v2: voteTotal(ev),
                              })}
                            </Badge>
                          )}
                          {/* 隐藏于「活动推广」的活动在列表里要能一眼认出来，
                              否则站长会疑惑「我发的活动用户怎么看不到」 */}
                          {ev.promoHidden && (
                            <Badge variant="outline">{t("vote.adm.promoOffBadge")}</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">{t("adm.1040", { v0: ev.claimCount ?? 0, v1: ev.maxClaims != null ? `/${ev.maxClaims}` : "" })}</span>
                        </div>
                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                          {ev.title}
                          {/* 分享链接快捷复制：活动靠 /activity/<id> 链接传播，
                              「不在活动推广显示」的活动更是只能靠链接，随手可复制很重要 */}
                          <button
                            type="button"
                            onClick={() => void copyEventLink(ev)}
                            title={t("adm.copyEventLink")}
                            aria-label={t("adm.copyEventLink")}
                            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            {copiedEventId === ev.id ? (
                              <>
                                <Check className="h-3 w-3" />
                                {t("common.copied")}
                              </>
                            ) : (
                              <>
                                <Link2 className="h-3 w-3" />
                                {t("adm.copyLinkShort")}
                              </>
                            )}
                          </button>
                        </p>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {ev.body}
                        </p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {ev.startsAt || ev.endsAt
                            ? t("adm.1041", { v0: ev.startsAt ? new Date(ev.startsAt).toLocaleString("zh-CN") : t("adm.167"), v1: ev.endsAt ? new Date(ev.endsAt).toLocaleString("zh-CN") : t("adm.168") })
                            : t("adm.169")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {/* 开奖按钮：抽奖与「多数/少数得奖」的投票都需要（后端按条件类型分发）。
                            「参与即可获奖」「投票后立刻结算」两档在投票时就发完了，不显示按钮。 */}
                        {ev.lottery && !ev.lottery.drawn && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={eventBusy}
                            onClick={() => void handleDrawEvent(ev)}
                          >
                            {t("adm.424")}
                          </Button>
                        )}
                        {ev.vote && !ev.vote.drawn && needsDrawForVote(ev.vote.rewardRule) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={eventBusy}
                            onClick={() => void handleDrawEvent(ev)}
                          >
                            {t("adm.voteDraw")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => void openClaimsDialog(ev)}
                        >
                          {t("adm.425")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEventDialog(ev)}
                          aria-label={t("adm.281")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteEvent(ev)}
                          aria-label={t("adm.282")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="points">
          <PointsAdminPanel />
        </TabsContent>

        <TabsContent value="community">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t("adm.287")}
                value={communityUserFilter}
                onChange={(e) => setCommunityUserFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void loadCommunity() }}
                className="pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={communityShowDeleted}
                onCheckedChange={(v) => { setCommunityShowDeleted(v); }}
              />
              {t("adm.449")}
            </label>
            <Button variant="outline" size="sm" onClick={() => void loadCommunity()}>
              <RefreshCw className="h-4 w-4" />
              {t("adm.450")}
            </Button>
          </div>

          {communityLoading ? (
            <LoadingBlock variant="list" />
          ) : communityPosts.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title={t("adm.288")}
              description={t("adm.289")}
            />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">{t("adm.451")}</TableHead>
                    <TableHead>{t("adm.452")}</TableHead>
                    <TableHead className="w-28">{t("adm.453")}</TableHead>
                    <TableHead className="w-28">{t("adm.454")}</TableHead>
                    <TableHead className="w-20">{t("adm.455")}</TableHead>
                    <TableHead className="w-24">{t("adm.456")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {communityPosts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.nickname || p.username}
                        <div className="text-xs text-muted-foreground">@{p.username}</div>
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={p.body}>
                        {p.body}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(p.created_at)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{t("adm.1051", { v0: p.like_count, v1: p.comment_count, v2: p.share_count })}</TableCell>
                      <TableCell>
                        {p.deleted_at ? (
                          <Badge variant="destructive">{t("adm.457")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("adm.458")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.deleted_at ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleRestoreCommunityPost(p.id)}
                          >
                            <RotateCcw className="h-4 w-4" />
                            {t("adm.459")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDeleteCommunityPost(p.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t("adm.460")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="oauth">
          <OAuthAdminPanel />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsPanel />
        </TabsContent>

        <TabsContent value="perf">
          <PerfPanel />
        </TabsContent>

        <TabsContent value="cfQuota">
          <CfQuotaPanel />
        </TabsContent>

        <TabsContent value="audit">
          <AuditPanel />
        </TabsContent>

        <TabsContent value="settings">
          {settingsLoading ? (
            <LoadingBlock variant="form" />
          ) : (
            <SectionedCards pageKey="settings">

              {/* 每日签到配置 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.1260")}</CardTitle>
                  <CardDescription>{t("adm.1261")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.1262")}</p>
                      <p className="text-xs text-muted-foreground">{t("adm.1263")}</p>
                    </div>
                    <Switch checked={checkinEnabled} onCheckedChange={setCheckinEnabled} />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="checkinMin">{t("adm.1264")}</Label>
                      <Input
                        id="checkinMin"
                        type="number"
                        min={0}
                        value={checkinMin}
                        onChange={(e) => setCheckinMin(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="checkinMax">{t("adm.1265")}</Label>
                      <Input
                        id="checkinMax"
                        type="number"
                        min={0}
                        value={checkinMax}
                        onChange={(e) => setCheckinMax(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("adm.1266")}</p>

                  <div className="space-y-2">
                    <Label htmlFor="checkinMilestones">{t("adm.1267")}</Label>
                    <Textarea
                      id="checkinMilestones"
                      rows={5}
                      className="font-mono text-sm"
                      value={checkinMilestones}
                      onChange={(e) => setCheckinMilestones(e.target.value)}
                      placeholder={"7:50\n30:300\n100:1000"}
                    />
                    <p className="text-xs text-muted-foreground">{t("adm.1268")}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.downloadTitle")}</CardTitle>
                  <CardDescription>{t("adm.downloadDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="downloadAndroidUrl">{t("adm.downloadAndroid")}</Label>
                      <Input
                        id="downloadAndroidUrl"
                        placeholder="https://…"
                        value={downloadAndroidUrl}
                        onChange={(e) => setDownloadAndroidUrl(e.target.value)}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="downloadWindowsUrl">{t("adm.downloadWindows")}</Label>
                      <Input
                        id="downloadWindowsUrl"
                        placeholder="https://…"
                        value={downloadWindowsUrl}
                        onChange={(e) => setDownloadWindowsUrl(e.target.value)}
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>




              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.619")}</CardTitle>
                  <CardDescription>
                    {t("adm.620")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="communityPostMaxImages">{t("adm.621")}</Label>
                      <Input
                        id="communityPostMaxImages"
                        type="number"
                        min={0}
                        max={9}
                        value={communityPostMaxImages}
                        onChange={(e) => setCommunityPostMaxImages(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="communityImageMaxKb">{t("adm.622")}</Label>
                      <Input
                        id="communityImageMaxKb"
                        type="number"
                        min={1}
                        value={communityImageMaxKb}
                        onChange={(e) => setCommunityImageMaxKb(e.target.value)}
                      />
                    </div>
                    {/* 评论修改次数上限（2026-10-17）：0 = 禁止修改，默认 2 */}
                    <div className="space-y-2">
                      <Label htmlFor="communityCommentEditLimit">{t("adm.commentEditLimit")}</Label>
                      <Input
                        id="communityCommentEditLimit"
                        type="number"
                        min={0}
                        max={10}
                        value={communityCommentEditLimit}
                        onChange={(e) => setCommunityCommentEditLimit(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("adm.commentEditLimitHint")}
                      </p>
                    </div>
                  </div>

                  {/* 帖子分类（2026-10-07：从硬编码改为可配）
                      保存后前端立即生效 —— 分类是 /community/config 下发的，不需要重新发版 */}
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.cat.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("adm.cat.hint")}</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setPostCategories((list) => [...list, { key: "", zh: "", en: "" }])
                        }
                      >
                        <Plus className="h-3.5 w-3.5" /> {t("adm.cat.add")}
                      </Button>
                    </div>
                    {postCategories.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("adm.cat.empty")}</p>
                    ) : (
                      <div className="space-y-2">
                        {postCategories.map((c, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-2">
                            <Input
                              className="w-[128px] font-mono text-xs"
                              value={c.key}
                              placeholder={t("adm.cat.key")}
                              onChange={(e) => patchCategory(i, { key: e.target.value })}
                            />
                            <Input
                              className="w-[128px]"
                              value={c.zh}
                              placeholder={t("adm.cat.zh")}
                              onChange={(e) => patchCategory(i, { zh: e.target.value })}
                            />
                            <Input
                              className="w-[128px]"
                              value={c.en}
                              placeholder={t("adm.cat.en")}
                              onChange={(e) => patchCategory(i, { en: e.target.value })}
                            />
                            <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={!!c.water}
                                onChange={(e) => patchCategory(i, { water: e.target.checked })}
                              />
                              {t("adm.cat.water")}
                            </label>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={t("common.delete")}
                              onClick={() =>
                                setPostCategories((list) => list.filter((_, j) => j !== i))
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.623")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.624")}
                      </p>
                    </div>
                    <Switch
                      checked={communityGuestAccess}
                      onCheckedChange={setCommunityGuestAccess}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.625")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.626")}
                      </p>
                    </div>
                    <Switch
                      checked={communityEnabled}
                      onCheckedChange={setCommunityEnabled}
                    />
                  </div>
                  {/*
                    {t("adm.627")}
                    {t("adm.628")}
                    {t("adm.629")}
                  */}
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.630")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.631")}
                        {t("adm.632")}
                      </p>
                    </div>
                    <Switch checked={chatEnabled} onCheckedChange={setChatEnabled} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.tz.title")}</CardTitle>
                  <CardDescription>{t("adm.tz.desc")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="siteTzOffset">{t("adm.tz.label")}</Label>
                      <Input
                        id="siteTzOffset"
                        type="number"
                        min={-12}
                        max={14}
                        className="w-32"
                        value={siteTzOffsetHours}
                        onChange={(e) => setSiteTzOffsetHours(e.target.value)}
                      />
                    </div>
                    <p className="max-w-md text-xs text-muted-foreground">{t("adm.tz.hint")}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.633")}</CardTitle>
                  <CardDescription>
                    {t("adm.634")}
                    {t("adm.635")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.636")}</p>
                      <p className="text-xs text-muted-foreground">
                        {openRegistration
                          ? t("adm.176")
                          : t("adm.177")}
                      </p>
                    </div>
                    <Switch
                      checked={openRegistration}
                      onCheckedChange={setOpenRegistration}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openRegUntil">{t("adm.1105")}</Label>
                    <Input
                      id="openRegUntil"
                      type="datetime-local"
                      value={openRegistrationUntil}
                      onChange={(e) => setOpenRegistrationUntil(e.target.value)}
                      disabled={!openRegistration}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.637")}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.638")}
                    {t("adm.639")}
                  </p>

                  <div className="space-y-2 border-t pt-4">
                    <Label htmlFor="inviteQuotaBase">{t("adm.671")}</Label>
                    <Input
                      id="inviteQuotaBase"
                      inputMode="numeric"
                      value={inviteQuotaBase}
                      onChange={(e) => setInviteQuotaBase(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.672")}
                    </p>
                    {openRegistration && (
                      <p className="text-xs text-amber-600">
                        {t("adm.regQuotaPaused")}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 border-t pt-4">
                    <Label htmlFor="regEmailDomains">{t("adm.regEmailDomains")}</Label>
                    <Textarea
                      id="regEmailDomains"
                      rows={3}
                      className="font-mono text-xs"
                      value={registerEmailDomains}
                      onChange={(e) => setRegisterEmailDomains(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.regEmailDomainsHint")}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="regIpLimit">{t("adm.regIpDailyLimit")}</Label>
                    <Input
                      id="regIpLimit"
                      type="number"
                      min={0}
                      className="w-32"
                      value={registerIpDailyLimit}
                      onChange={(e) => setRegisterIpDailyLimit(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.regIpDailyLimitHint")}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="riskThreshold">{t("adm.riskThreshold")}</Label>
                    <Input
                      id="riskThreshold"
                      type="number"
                      min={1}
                      className="w-32"
                      value={riskPeakThreshold}
                      onChange={(e) => setRiskPeakThreshold(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.riskThresholdHint")}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* ---- 2026-09-26 补齐的设置卡片 ---- */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("adm.659")}</CardTitle>
                  <CardDescription>
                    {t("adm.660")}
                    {t("adm.661")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.666")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("adm.667")}
                        </p>
                      </div>
                      <Switch
                        checked={achievementRewardEnabled}
                        onCheckedChange={setAchievementRewardEnabled}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div className="space-y-2">
                        <Label htmlFor="achievementRewardPlanId">{t("adm.668")}</Label>
                        <Input
                          id="achievementRewardPlanId"
                          inputMode="numeric"
                          value={achievementRewardPlanId}
                          onChange={(e) => setAchievementRewardPlanId(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="achievementRewardPoints">{t("adm.669")}</Label>
                        <Input
                          id="achievementRewardPoints"
                          inputMode="numeric"
                          value={achievementRewardPoints}
                          onChange={(e) => setAchievementRewardPoints(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.670")}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* 积分系统的配置（开关 / 比例 / 每日上限）已挪到 管理面板 → 积分 → 商城，
                  因为「兑换」现在就是商城里的一件商品（2026-09-28 站长要求）。 */}

              {/* 「AI实验室 Agent 提示词」已搬到独立的「AI 实验室」栏目
                  （见 components/admin-lab-tab.tsx）—— 它的兄弟配置项
                  （模型来源、免费额度、免费渠道）都在那边，留在设置页会拆成两处。 */}

              {/* 保存按钮：SectionedCards 会把非 Card 子元素固定在卡片下方，
                  所以任何分区下都能直接保存，不必先切到「其他」标签。 */}
              <div className="flex justify-end">
                <Button onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                  {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("adm.681")}
                </Button>
              </div>
            </SectionedCards>
          )}
        </TabsContent>

        <TabsContent value="permissions">
          <AdminPermissionsPanel isRoot={user?.role === "root"} />
        </TabsContent>
          </div>
        </div>
      </Tabs>

      {/* 编辑邀请码权限 */}
      <Dialog
        open={permInvite !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPermInvite(null)
            setPermDraft(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adm.735")}</DialogTitle>
            <DialogDescription>{t("adm.1122", { v0: permInvite?.code, v1: t("adm.736") })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div
                key={f.key}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t(f.label)}</p>
                  <p className="text-xs text-muted-foreground">{t(f.desc)}</p>
                </div>
                <Switch
                  checked={permDraft?.[f.key] ?? false}
                  onCheckedChange={(v) =>
                    setPermDraft((d) => (d ? { ...d, [f.key]: v } : d))
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPermInvite(null)
                setPermDraft(null)
              }}
            >
              {t("adm.737")}
            </Button>
            <Button onClick={() => void handleSaveInvitePerms()} disabled={permBusy}>
              {permBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.738")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 用户邀请码详情 */}
      <Dialog
        open={quotaDetail !== null}
        onOpenChange={(o) => {
          if (!o) setQuotaDetail(null)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {quotaDetail && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono">{t("adm.1123", { v0: quotaDetail.username })}</DialogTitle>
                <DialogDescription>
                  {t("adm.739")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">{t("adm.740")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t("adm.1124", { v0: quotaDetail.quota.inviteRemaining, v1: " ", v2: quotaDetail.quota.inviteTotal, v3: " ", v4: quotaDetail.quota.inviteBase, v5: " ", v6: quotaDetail.quota.inviteBonus, v7: " ", v8: quotaDetail.quota.inviteUsed })}</p>
                  {quotaDetail.quota.inviteBaseSuppressed && (
                    <p className="mt-1 text-xs text-amber-600">{t("adm.regQuotaPaused")}</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Label className="text-xs">{t("adm.741")}</Label>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 w-24"
                      disabled={quotaDetailBusy}
                      defaultValue={quotaDetail.quota.inviteBonus}
                      onBlur={(e) =>
                        void handleAdjustQuota(quotaDetail.username, {
                          inviteBonus: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.1126", { v0: quotaDetail.invites.length })}</h3>
                  {quotaDetail.invites.length === 0 ? (
                    <p className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                      {t("adm.745")}
                    </p>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {quotaDetail.invites.map((inv) => {
                        /**
                         * ⚠️ 2026-11-06：模块级额度已下线，后端不再返回
                         * `quotaFeatures` / `basicFeatures` / `featureLabels`。
                         * 原先这里 `quotaDetail.quotaFeatures.filter(...)` 会在
                         * undefined 上调用 .filter ⇒ 渲染抛错 ⇒ 整个弹窗卡死、
                         * 点「关闭」也没反应（用户报的就是这个）。
                         * 邀请码现在只剩「邀请码额度」一种配额，这里不再展示模块徽标。
                         */
                        const used = inv.usedCount >= inv.maxUses
                        return (
                          <div
                            key={inv.id}
                            className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                          >
                            <span className="font-mono">{inv.code}</span>
                            <Badge variant="outline">{t("adm.746")}</Badge>
                            <Badge variant={used ? "destructive" : "success"}>
                              {used ? t("adm.1127") : t("adm.1128")}
                            </Badge>
                            <span className="ml-auto text-muted-foreground">
                              {fmtTime(inv.createdAt)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              title={t("adm.305")}
                              onClick={async () => {
                                try {
                                  await adminApi.deleteInvite(inv.id)
                                  toast.success(t("adm.185"))
                                  void openQuotaDetail(quotaDetail.username)
                                  void loadInviteQuotas()
                                } catch (err) {
                                  toast.error(
                                    err instanceof HttpError
                                      ? err.message
                                      : t("adm.186")
                                  )
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 添加邀请码 */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adm.747")}</DialogTitle>
            <DialogDescription>
              {t("adm.748")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inviteCode">{t("adm.749")}</Label>
              <Input
                id="inviteCode"
                placeholder="FRIENDS-02"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteMax">{t("adm.750")}</Label>
              <Input
                id="inviteMax"
                type="number"
                min={1}
                max={1000}
                value={inviteMax}
                onChange={(e) => setInviteMax(e.target.value)}
              />
            </div>
            <div className="space-y-3">
              <Label>{t("adm.751")}</Label>
              {FEATURES.map((f) => (
                <div
                  key={f.key}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t(f.label)}</p>
                    <p className="text-xs text-muted-foreground">{t(f.desc)}</p>
                  </div>
                  <Switch
                    checked={invitePerms[f.key]}
                    onCheckedChange={(v) =>
                      setInvitePerms((prev) => ({ ...prev, [f.key]: v }))
                    }
                  />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {t("adm.752")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              {t("adm.753")}
            </Button>
            <Button onClick={() => void handleCreateInvite()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.754")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 邀请码溯源弹窗：用户列表点邀请码 / 邀请码列表点码都能打开 */}
      <Dialog
        open={traceCode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTraceCode(null)
            setTraceData(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Network className="h-4 w-4" />
              {t("adm.1289")}
            </DialogTitle>
            <DialogDescription>
              {traceData ? t("adm.1290", { v0: traceData.invite.code }) : t("adm.1291")}
            </DialogDescription>
          </DialogHeader>
          {traceBusy ? (
            <LoadingBlock variant="cards" />
          ) : traceData ? (
            <div className="space-y-4">
              {/* 一人多号警示：出现共享注册 IP 时置顶显示 */}
              {traceData.sharedIps.length > 0 && (
                <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-destructive">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {t("adm.1292")}
                  </p>
                  {traceData.sharedIps.map((g) => (
                    <p key={g.ip} className="font-mono break-all">
                      {g.ip} — {g.names.join("、")}
                    </p>
                  ))}
                  <p className="text-muted-foreground">{t("adm.1293")}</p>
                </div>
              )}

              {/* 邀请码本体 */}
              <div className="space-y-1 rounded-md border p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("adm.344")}</span>
                  <span>{fmtTime(traceData.invite.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("adm.342")}</span>
                  <span>
                    {traceData.invite.usedCount} / {traceData.invite.maxUses}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("adm.1294")}</span>
                  <span>
                    {traceData.invite.expiresAt
                      ? fmtTime(traceData.invite.expiresAt)
                      : t("adm.1295")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  <span className="text-muted-foreground">{t("adm.343")}</span>
                  {FEATURES.filter((f) => traceData.invite.permissions[f.key]).length === 0 ? (
                    <Badge variant="destructive">{t("adm.347")}</Badge>
                  ) : (
                    FEATURES.filter((f) => traceData.invite.permissions[f.key]).map((f) => (
                      <Badge key={f.key} variant="outline">
                        {t(f.label)}
                      </Badge>
                    ))
                  )}
                </div>
              </div>

              {/* 创建者 */}
              <section>
                <h4 className="mb-2 text-sm font-medium">{t("adm.1296")}</h4>
                <div className="space-y-1 rounded-md border p-3 text-xs">
                  {traceData.creator ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="font-mono text-sm text-primary hover:underline"
                          onClick={() => void openDetail(traceData.creator!.username)}
                        >
                          {traceData.creator.username}
                        </button>
                        {traceData.creator.uid != null && (
                          <span className="text-muted-foreground">
                            {fmtUid(traceData.creator.uid)}
                          </span>
                        )}
                        <span className="text-muted-foreground">{traceData.creator.email}</span>
                        <Badge
                          variant={
                            traceData.creator.status === "suspended" ? "destructive" : "success"
                          }
                        >
                          {traceData.creator.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">
                        {t("adm.1301")} {fmtTime(traceData.creator.createdAt)} · {t("adm.1300")}{" "}
                        {traceData.creator.registerIp ?? t("adm.981")}
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">{t("adm.1297")}</p>
                  )}
                </div>
              </section>

              {/* 使用者 */}
              <section>
                <h4 className="mb-2 text-sm font-medium">
                  {t("adm.1298", { v0: traceData.users.length })}
                </h4>
                {traceData.users.length === 0 ? (
                  <p className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                    {t("adm.1299")}
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {traceData.users.map((u) => (
                      <div
                        key={u.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                      >
                        <button
                          type="button"
                          className="font-mono text-sm text-primary hover:underline"
                          onClick={() => void openDetail(u.username)}
                        >
                          {u.username}
                        </button>
                        {u.uid != null && (
                          <span className="text-muted-foreground">{fmtUid(u.uid)}</span>
                        )}
                        <span className="text-muted-foreground">{u.email}</span>
                        <Badge variant={u.status === "suspended" ? "destructive" : "success"}>
                          {u.status}
                        </Badge>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {t("adm.1301")} {fmtTime(u.usedAt)} · {t("adm.1300")}{" "}
                          {u.registerIp ?? t("adm.981")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 公告编辑弹窗 */}
      <Dialog open={announcementOpen} onOpenChange={setAnnouncementOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{annDraft.id ? t("adm.1129") : t("adm.1130")}</DialogTitle>
            <DialogDescription>
              {t("adm.755")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="annTitle">{t("adm.756")}</Label>
              <Input
                id="annTitle"
                placeholder={t("adm.306")}
                value={annDraft.title}
                onChange={(e) => setAnnDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="annBody">{t("adm.757")}</Label>
              <Textarea
                id="annBody"
                placeholder={t("adm.307")}
                rows={4}
                value={annDraft.body}
                onChange={(e) => setAnnDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t("adm.758")}</Label>
                <Select
                  value={annDraft.category}
                  onValueChange={(v) => setAnnDraft((d) => ({ ...d, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">{t("adm.759")}</SelectItem>
                    <SelectItem value="frp">{t("adm.760")}</SelectItem>
                    <SelectItem value="ai">{t("adm.761")}</SelectItem>
                    <SelectItem value="proxy">{t("adm.762")}</SelectItem>
                    <SelectItem value="storage">{t("adm.763")}</SelectItem>
                    <SelectItem value="profile">{t("adm.764")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <div className="flex w-full items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.765")}</p>
                    <p className="text-xs text-muted-foreground">{t("adm.766")}</p>
                  </div>
                  <Switch
                    checked={annDraft.pinned}
                    onCheckedChange={(v) => setAnnDraft((d) => ({ ...d, pinned: v }))}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("adm.767")}</Label>
              <Select
                value={annDraft.status}
                onValueChange={(v) => setAnnDraft((d) => ({ ...d, status: v as AnnouncementStatus }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="published">{t("adm.768")}</SelectItem>
                  <SelectItem value="scheduled">{t("adm.769")}</SelectItem>
                  <SelectItem value="draft">{t("adm.770")}</SelectItem>
                </SelectContent>
              </Select>
              {annDraft.status === "scheduled" && (
                <div className="space-y-2 pt-1">
                  <Label htmlFor="annPublishAt">{t("adm.771")}</Label>
                  <Input
                    id="annPublishAt"
                    type="datetime-local"
                    value={annDraft.publishAt}
                    onChange={(e) => setAnnDraft((d) => ({ ...d, publishAt: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.772")}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("adm.773")}</Label>
              <Select
                value={annDraft.popupMode}
                onValueChange={(v) => setAnnDraft((d) => ({ ...d, popupMode: v as "none" | "once" | "every" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("adm.774")}</SelectItem>
                  <SelectItem value="once">{t("adm.775")}</SelectItem>
                  <SelectItem value="every">{t("adm.776")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("adm.777")}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("adm.778")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("adm.779")}
                </p>
              </div>
              <Switch
                checked={annDraft.notifyByEmail}
                onCheckedChange={(v) => setAnnDraft((d) => ({ ...d, notifyByEmail: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnouncementOpen(false)}>
              {t("adm.780")}
            </Button>
            <Button onClick={() => void handleSaveAnnouncement()} disabled={announcementBusy}>
              {announcementBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {annDraft.status === "draft"
                ? t("adm.187")
                : annDraft.status === "scheduled"
                  ? t("adm.188")
                  : annDraft.id
                    ? t("adm.189")
                    : t("adm.190")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 活动编辑弹窗 */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{eventDraft.id ? t("adm.1131") : t("adm.1132")}</DialogTitle>
            <DialogDescription>
              {t("adm.781")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="evTitle">{t("adm.782")}</Label>
              <Input
                id="evTitle"
                placeholder={t("adm.308")}
                value={eventDraft.title}
                onChange={(e) => setEventDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="evBody">{t("adm.783")}</Label>
              <Textarea
                id="evBody"
                rows={6}
                placeholder={t("adm.309")}
                value={eventDraft.body}
                onChange={(e) => setEventDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t("adm.784")}</Label>
                <Select
                  value={eventDraft.status}
                  onValueChange={(v) => setEventDraft((d) => ({ ...d, status: v as EventStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {t(o.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="evRewardLabel">{t("adm.785")}</Label>
                <Input
                  id="evRewardLabel"
                  placeholder={t("adm.310")}
                  value={eventDraft.rewardLabel}
                  onChange={(e) => setEventDraft((d) => ({ ...d, rewardLabel: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="evStart">{t("adm.1133")}</Label>
                <Input
                  id="evStart"
                  type="datetime-local"
                  value={eventDraft.startsAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, startsAt: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="evEnd">{t("adm.1134")}</Label>
                <Input
                  id="evEnd"
                  type="datetime-local"
                  value={eventDraft.endsAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, endsAt: e.target.value }))}
                />
              </div>
            </div>

            {eventDraft.status === "scheduled" && (
              <div className="space-y-2">
                <Label htmlFor="evPublishAt">{t("adm.786")}</Label>
                <Input
                  id="evPublishAt"
                  type="datetime-local"
                  value={eventDraft.publishAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, publishAt: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("adm.787")}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t("adm.788")}</Label>
              <Select
                value={eventDraft.rewardType}
                disabled={eventDraft.conditionType === "lottery"}
                onValueChange={(v) =>
                  setEventDraft((d) => ({ ...d, rewardType: v as EventRewardType }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REWARD_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {t(o.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eventDraft.conditionType === "lottery" && (
                <p className="text-xs text-muted-foreground">
                  {t("adm.789")}
                </p>
              )}
              {eventDraft.conditionType !== "lottery" &&
                (eventDraft.rewardType === "newapi_quota" ||
                  eventDraft.rewardType === "invite_quota" ||
                  eventDraft.rewardType === "points") && (
                  <div className="space-y-2 pt-1">
                    {/* 积分奖励支持「区间随机」：打开后改用上下限两个输入框 */}
                    {eventDraft.rewardType === "points" && (
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{t("adm.790")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("adm.791")}
                          </p>
                        </div>
                        <Switch
                          checked={eventDraft.pointsRandom}
                          onCheckedChange={(v) =>
                            setEventDraft((d) => ({ ...d, pointsRandom: v }))
                          }
                        />
                      </div>
                    )}

                    {eventDraft.rewardType === "points" && eventDraft.pointsRandom ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="evRewardMin">{t("adm.792")}</Label>
                          <Input
                            id="evRewardMin"
                            type="number"
                            // 不设 min：下限允许负数 = 扣积分（2026-10-07 站长要求）
                            placeholder={t("adm.ph.pointsMin")}
                            value={eventDraft.rewardMin}
                            onChange={(e) =>
                              setEventDraft((d) => ({ ...d, rewardMin: e.target.value }))
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="evRewardMax">{t("adm.793")}</Label>
                          <Input
                            id="evRewardMax"
                            type="number"
                            placeholder={t("adm.ph.pointsMax")}
                            value={eventDraft.rewardMax}
                            onChange={(e) =>
                              setEventDraft((d) => ({ ...d, rewardMax: e.target.value }))
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <Label htmlFor="evAmount">
                          {eventDraft.rewardType === "newapi_quota"
                            ? t("adm.191")
                            : eventDraft.rewardType === "points"
                              ? t("adm.192")
                              : t("adm.193")}
                        </Label>
                        <Input
                          id="evAmount"
                          type="number"
                          // 不设 min：积分填负数 = 扣积分（其它两种奖励类型由后端兜底校验正整数）
                          placeholder={
                            eventDraft.rewardType === "newapi_quota"
                              ? "1"
                              : eventDraft.rewardType === "points"
                                ? t("adm.ph.pointsFixed")
                                : "2"
                          }
                          value={eventDraft.rewardAmount}
                          onChange={(e) =>
                            setEventDraft((d) => ({ ...d, rewardAmount: e.target.value }))
                          }
                        />
                      </>
                    )}
                    {eventDraft.rewardType === "newapi_quota" && (
                      <p className="text-xs text-muted-foreground">{t("adm.1135", { v0: " ", v1: quotaPerUnit.toLocaleString(), v2: t("adm.794") })}</p>
                    )}
                    {eventDraft.rewardType === "points" && (
                      <p className="text-xs text-muted-foreground">{t("adm.1136", { v0: t("adm.795"), v1: t("adm.796"), v2: t("adm.797") })}
                        <br />
                        {t("adm.pointsNegative")}
                        {eventDraft.pointsRandom && (
                          <>
                            <br />
                            {t("adm.798")}
                            {t("adm.799")}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="evMaxClaims">
                {/* 抽奖与投票限制的都是「参与人数」，与限量领取的份数不是一回事 */}
                {eventDraft.conditionType === "lottery" || eventDraft.conditionType === "vote"
                  ? t("adm.194")
                  : t("adm.195")}
              </Label>
              <Input
                id="evMaxClaims"
                type="number"
                min={1}
                placeholder={t("adm.311")}
                value={eventDraft.maxClaims}
                onChange={(e) => setEventDraft((d) => ({ ...d, maxClaims: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {eventDraft.conditionType === "lottery" || eventDraft.conditionType === "vote"
                  ? t("adm.196")
                  : t("adm.197")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("adm.800")}</Label>
              <Select
                value={eventDraft.conditionType}
                onValueChange={(v) =>
                  setEventDraft((d) => ({
                    ...d,
                    conditionType: v as EventConditionType,
                    // 抽奖固定发积分：选它时顺手把奖励类型切过去，避免提交时被后端拒绝
                    rewardType: v === "lottery" ? "points" : d.rewardType,
                    /**
                     * 🔴 选「问卷」时**顺手把问卷 JSON 填上模板**（站长 2026-10-15 反馈
                     * "类型选了问卷，下面啥都没显示"）。
                     * 原因：新活动的 quizJson 是空串 ⇒ 图形化编辑器解析不出东西，只显示一行
                     * 报错，看起来就像界面坏了。给个能直接用的模板，改题干/选项即可。
                     */
                    quizJson: v === "quiz" && !d.quizJson.trim() ? QUIZ_TEMPLATE : d.quizJson,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {t(o.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eventDraft.conditionType === "has_feature" && (
                <div className="pt-1">
                  <Select
                    value={eventDraft.conditionFeature}
                    onValueChange={(v) => setEventDraft((d) => ({ ...d, conditionFeature: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEATURES.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {t(f.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {eventDraft.conditionType === "code" && (
                <div className="space-y-1.5 pt-1">
                  <Input
                    placeholder={t("adm.312")}
                    maxLength={64}
                    value={eventDraft.conditionCode}
                    onChange={(e) =>
                      setEventDraft((d) => ({ ...d, conditionCode: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.801")}
                    {t("adm.802")}
                  </p>
                </div>
              )}
              {(eventDraft.conditionType === "github_star" ||
                eventDraft.conditionType === "github_pr") && (
                <div className="space-y-1.5 pt-1">
                  <Input
                    placeholder={t("adm.313")}
                    maxLength={120}
                    value={eventDraft.conditionRepo}
                    onChange={(e) =>
                      setEventDraft((d) => ({ ...d, conditionRepo: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {eventDraft.conditionType === "github_pr" ? (
                      <>
                        {t("adm.condPrHint")}
                        <br />
                        <span className="font-medium text-destructive">
                          {t("adm.808")}
                        </span>{t("adm.1137")}<code className="font-mono">GITHUB_TOKEN</code>）：
                        {t("adm.condPrTokenHint")}
                      </>
                    ) : (
                      <>
                        {t("adm.803")}
                        <span className="font-medium">{t("adm.804")}</span>
                        {t("adm.805")}
                        {t("adm.806")}
                        {t("adm.807")}
                        <br />
                        <span className="font-medium text-destructive">
                          {t("adm.808")}
                        </span>{t("adm.1137")}<code className="font-mono">GITHUB_TOKEN</code>）：
                        {t("adm.809")}
                      </>
                    )}
                  </p>
                </div>
              )}
              {eventDraft.conditionType === "lottery" && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="evLotteryWinners">{t("adm.810")}</Label>
                      <Input
                        id="evLotteryWinners"
                        type="number"
                        min={1}
                        max={200}
                        value={eventDraft.lotteryWinners}
                        onChange={(e) =>
                          setEventDraft((d) => ({ ...d, lotteryWinners: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="evLotteryPool">{t("adm.811")}</Label>
                      <Input
                        id="evLotteryPool"
                        type="number"
                        min={1}
                        value={eventDraft.lotteryPool}
                        onChange={(e) =>
                          setEventDraft((d) => ({ ...d, lotteryPool: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("adm.812")}</Label>
                    <Select
                      value={eventDraft.lotteryMode}
                      onValueChange={(v) =>
                        setEventDraft((d) => ({ ...d, lotteryMode: v as "even" | "random" }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="even">{t("adm.813")}</SelectItem>
                        <SelectItem value="random">{t("adm.814")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.815")}
                    {t("adm.816")}
                    {t("adm.817")}
                    {t("adm.818")}
                    {t("adm.819")}
                  </p>
                  {Number(eventDraft.lotteryPool) > 0 &&
                    Number(eventDraft.lotteryPool) < Number(eventDraft.lotteryWinners) && (
                      <p className="text-xs text-destructive">
                        {t("adm.820")}
                      </p>
                    )}
                </div>
              )}
              {/*
                问卷（独立类型 quiz）：与投票**平级**，不走选项 / 获奖规则那套。
                ⚠️ 必须放在上面「投票」那段的**外面** —— 之前放在里面，选了问卷后
                   conditionType 不再是 vote ⇒ 整段（含编辑器）被跳过 ⇒ 界面上啥都没有
                   （站长 2026-10-15 实测反馈）。
              */}
              {eventDraft.conditionType === "quiz" && (
                <>
                  <QuizEditor
                    value={eventDraft.quizJson}
                    onChange={(json) => setEventDraft({ ...eventDraft, quizJson: json })}
                  />
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t("quiz.adm.advanced")}
                    </summary>
                    <textarea
                      className="mt-2 h-56 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
                      placeholder={t("quiz.adm.placeholder")}
                      value={eventDraft.quizJson}
                      onChange={(e) => setEventDraft({ ...eventDraft, quizJson: e.target.value })}
                    />
                  </details>
                </>
              )}

              {eventDraft.conditionType === "vote" && (
                <div className="space-y-4 pt-1">
                  {/* 选项编辑器：至少 2 项，可增删；每项 = 标题 + 说明 + 配图 */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label>{t("vote.adm.options")}</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={eventDraft.voteOptions.length >= 20}
                        onClick={() =>
                          setEventDraft((d) => ({
                            ...d,
                            voteOptions: [
                              ...d.voteOptions,
                              { key: newOptionKey(), label: "", desc: "", image: "" },
                            ],
                          }))
                        }
                      >
                        <Plus className="h-4 w-4" />
                        {t("vote.adm.addOption")}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("vote.adm.optionsHint")}</p>

                    {/* 投票形态：普通投票 / 问卷（问卷直接粘 JSON，见 quizJson 注释） */}

                    <div className="flex flex-wrap items-center gap-3">

                      <label className="flex items-center gap-2 text-sm">

                        <input

                          type="checkbox"

                          checked={eventDraft.quizMode}

                          onChange={(e) => setEventDraft({ ...eventDraft, quizMode: e.target.checked })}

                        />

                        {t("quiz.adm.mode")}

                      </label>

                      <span className="text-xs text-muted-foreground">{t("quiz.adm.modeHint")}</span>

                    </div>

                    {quizActive && (
                <>
                  {/* 图形化编辑器：题目/选项/正确答案/发奖分档都能点着改（站长要求） */}
                  <QuizEditor
                    value={eventDraft.quizJson}
                    onChange={(json) => setEventDraft({ ...eventDraft, quizJson: json })}
                  />
                  {/* 高级：直接改 JSON。它和上面的表单是**同一份数据**，双向同步 */}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t("quiz.adm.advanced")}
                    </summary>
                    <textarea
                      className="mt-2 h-56 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
                      placeholder={t("quiz.adm.placeholder")}
                      value={eventDraft.quizJson}
                      onChange={(e) => setEventDraft({ ...eventDraft, quizJson: e.target.value })}
                    />
                  </details>
                </>
              )}

                    {quizActive && (

                      <Button

                        type="button"

                        variant="outline"

                        size="sm"

                        className="mt-2"

                        onClick={() => setEventDraft({ ...eventDraft, quizJson: QUIZ_TEMPLATE })}

                      >

                        {t("quiz.adm.fillExample")}

                      </Button>

                    )}

                    {/* 问卷模式下隐藏普通投票的选项列表（它和问卷是两种形态） */}
                    {!quizActive &&
                      eventDraft.voteOptions.map((opt, i) => (
                      <div key={opt.key} className="space-y-2 rounded-md border p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {t("vote.adm.optionN", { n: i + 1 })}
                          </span>
                          <div className="flex-1" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            // 至少留 2 行：投不了票的表单没有意义（后端也会拒）
                            disabled={eventDraft.voteOptions.length <= 2}
                            onClick={() =>
                              setEventDraft((d) => ({
                                ...d,
                                voteOptions: d.voteOptions.filter((o) => o.key !== opt.key),
                              }))
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Input
                            placeholder={t("vote.adm.optionLabel")}
                            maxLength={60}
                            value={opt.label}
                            onChange={(e) =>
                              setEventDraft((d) => ({
                                ...d,
                                voteOptions: d.voteOptions.map((o) =>
                                  o.key === opt.key ? { ...o, label: e.target.value } : o
                                ),
                              }))
                            }
                          />
                          <Input
                            placeholder={t("vote.adm.optionDesc")}
                            maxLength={200}
                            value={opt.desc}
                            onChange={(e) =>
                              setEventDraft((d) => ({
                                ...d,
                                voteOptions: d.voteOptions.map((o) =>
                                  o.key === opt.key ? { ...o, desc: e.target.value } : o
                                ),
                              }))
                            }
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {opt.image ? (
                            <>
                              <img
                                src={opt.image}
                                alt=""
                                className="h-14 w-14 rounded-md border object-cover"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setEventDraft((d) => ({
                                    ...d,
                                    voteOptions: d.voteOptions.map((o) =>
                                      o.key === opt.key ? { ...o, image: "" } : o
                                    ),
                                  }))
                                }
                              >
                                {t("vote.adm.removeImage")}
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={voteImgUploading !== null}
                              onClick={() => {
                                voteImgTargetRef.current = opt.key
                                voteImgInputRef.current?.click()
                              }}
                            >
                              {voteImgUploading === opt.key ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <ImagePlus className="h-4 w-4" />
                              )}
                              {t("vote.adm.addImage")}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {/* 问卷形态下「获奖规则」不适用（问卷按答对率发奖，见上面的「发奖口径」） */}
                    {!quizActive && (
                      <>
                    <Label>{t("vote.adm.rule")}</Label>
                    <Select
                      value={eventDraft.voteRule}
                      onValueChange={(v) =>
                        setEventDraft((d) => ({ ...d, voteRule: v as EventVoteRewardRule }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VOTE_RULE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {t(o.label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("vote.adm.ruleHint")}</p>
                      </>
                    )}

                    {/* 「指定选项获奖」：选一个获奖选项（只能从填了标题的选项里选） */}
                    {isFixedVoteRule(eventDraft.voteRule) && (
                      <div className="space-y-1.5 pt-1">
                        <Label>{t("vote.adm.fixedOption")}</Label>
                        <Select
                          value={eventDraft.voteFixedOptionId}
                          onValueChange={(v) =>
                            setEventDraft((d) => ({ ...d, voteFixedOptionId: v }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t("vote.adm.fixedOptionPlaceholder")} />
                          </SelectTrigger>
                          <SelectContent>
                            {eventDraft.voteOptions
                              .filter((o) => o.label.trim())
                              .map((o) => (
                                <SelectItem key={o.key} value={o.key}>
                                  {o.label.trim()}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t("vote.adm.fixedOptionHint")}
                        </p>
                      </div>
                    )}

                    {/* 「立刻结算」三档的副作用各不相同，分开提示 */}
                    {isInstantVoteRule(eventDraft.voteRule) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {isFixedVoteRule(eventDraft.voteRule)
                          ? t("vote.adm.instantFixedWarn")
                          : t("vote.adm.instantWarn")}
                      </p>
                    )}
                    {needsDrawForVote(eventDraft.voteRule) && (
                      <p className="text-xs text-muted-foreground">{t("vote.adm.drawHint")}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 消息中心「活动推广」开关：关了只能通过 /activity/<id> 链接参与 */}
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("vote.adm.promo")}</p>
                <p className="text-xs text-muted-foreground">{t("vote.adm.promoHint")}</p>
              </div>
              <Switch
                checked={!eventDraft.promoHidden}
                onCheckedChange={(v) =>
                  setEventDraft((d) => ({ ...d, promoHidden: !v }))
                }
              />
            </div>
          </div>

          {/* 投票选项配图的隐藏文件输入（各选项共用一个，见 voteImgInputRef 注释） */}
          <input
            ref={voteImgInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => void handleVoteImagePick(e.target.files?.[0])}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEventOpen(false)}>
              {t("adm.821")}
            </Button>            <Button onClick={() => void handleSaveEvent()} disabled={eventBusy}>
              {eventBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {eventDraft.status === "draft"
                ? t("adm.198")
                : eventDraft.status === "scheduled"
                  ? t("adm.199")
                  : eventDraft.id
                    ? t("adm.200")
                    : t("adm.201")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 活动领取名单 */}
      <Dialog open={claimsOpen} onOpenChange={setClaimsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("adm.1138")}{claimsEvent?.title}</DialogTitle>
            <DialogDescription>
              {t("adm.822")}
            </DialogDescription>
          </DialogHeader>
          {claimsLoading ? (
            <LoadingBlock variant="table" />
          ) : claims.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("adm.823")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adm.824")}</TableHead>
                  <TableHead>{t("adm.825")}</TableHead>
                  <TableHead>{t("adm.826")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.nickname || c.username || c.userId}
                      {/* 投票活动：显示这个人投给了哪个选项（选项标题要回活动配置里查） */}
                      {c.optionId && claimsEvent?.vote && (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {t("adm.votedFor", {
                            v0:
                              claimsEvent.vote.options.find((o) => o.id === c.optionId)?.label ??
                              c.optionId,
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(c.claimedAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.rewardStatus === "granted"
                            ? "success"
                            : c.rewardStatus === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {c.rewardStatus === "granted"
                          ? t("adm.202")
                          : c.rewardStatus === "failed"
                            ? t("adm.203")
                            : c.rewardStatus === "manual"
                              ? t("adm.204")
                              : c.rewardStatus === "lost"
                                ? t("adm.205")
                                : t("adm.206")}
                      </Badge>
                      {c.rewardDetail && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.rewardDetail}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* 抽奖未中奖（lost）不是待发放，不给「标记已发放」按钮 */}
                      {c.rewardStatus !== "granted" && c.rewardStatus !== "lost" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => void handleGrantClaim(c)}
                        >
                          {t("adm.827")}
                        </Button>
                      )}
                      {/* 删除这条领取记录：误参与 / 测试数据 / 卡住的人都能清掉，对方可重新参与 */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-1 h-7 text-destructive hover:text-destructive"
                        onClick={() => void handleDeleteClaim(c)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null)
            setOpenedMessage(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto overflow-x-hidden">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono">{detail.user.username}</span>
                  {detail.user.status === "suspended" ? (
                    <Badge variant="destructive">suspended</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                  {detail.user.role === "root" ? (
                    <Badge variant="secondary">{t("adm.844")}</Badge>
                  ) : detail.user.role === "superadmin" ? (
                    <Badge variant="secondary">{t("adm.perm.roleSuperadmin")}</Badge>
                  ) : detail.user.role === "admin" ? (
                    <Badge variant="secondary">{t("adm.perm.roleAdmin")}</Badge>
                  ) : null}
                </DialogTitle>
                <DialogDescription>{t("adm.1150", { v0: detail.user.nickname ? `${detail.user.nickname} · ` : "", v1: detail.user.email, v2: fmtTime(detail.user.createdAt) })}</DialogDescription>
              </DialogHeader>

              <div className="min-w-0 space-y-4">
                {/* ---- 账号：昵称 / 邮箱验证 / 通知 / 角色 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.845")}</h3>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-md border p-3">
                      <Input
                        className="max-w-xs"
                        value={nickDraft}
                        placeholder={t("adm.316")}
                        disabled={busy || detail.user.username === user?.username}
                        onChange={(e) => setNickDraft(e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">{t("adm.1151")}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        disabled={busy || detail.user.username === user?.username}
                        onClick={() => void handleSaveNickname()}
                      >
                        {t("adm.846")}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.847")}</p>
                        <p className="text-xs text-muted-foreground">{t("adm.1152", { v0: detail.user.email })}</p>
                      </div>
                      <Switch
                        checked={detail.user.emailVerified}
                        disabled={busy || detail.user.username === user?.username}
                        onCheckedChange={(v) =>
                          void handleToggleUserFlag("emailVerified", v)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.848")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("adm.849")}
                        </p>
                      </div>
                      <Switch
                        checked={detail.user.notifyEnabled}
                        disabled={busy || detail.user.username === user?.username}
                        onCheckedChange={(v) =>
                          void handleToggleUserFlag("notifyEnabled", v)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.level.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("adm.level.desc")}</p>
                      </div>
                      <Select
                        value={String(detail.user.memberLevel ?? 0)}
                        onValueChange={(v) => void handleSetMemberLevel(Number(v))}
                        disabled={busy}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {([0, 1, 2, 3] as const).map((lv) => (
                            <SelectItem key={lv} value={String(lv)}>
                              {t(`lvl.${lv}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* 会员银行卡号：黄金及以上才有；号发给谁就是谁的，升级不变 */}
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.card.userTitle")}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {detail.user.cardNo
                            ? detail.user.cardNo.replace(/(\d{4})(?=\d)/g, "$1 ")
                            : t("adm.card.none")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setCardNoUser(detail.user.username)}
                      >
                        {t("adm.card.manage")}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {detail.user.role === "root" ? t("adm.1153") : t("adm.1154")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {detail.user.role === "root"
                            ? t("adm.211")
                            : t("adm.212")}
                        </p>
                      </div>
                      <Switch
                        checked={
                          detail.user.role === "admin" ||
                          detail.user.role === "superadmin" ||
                          detail.user.role === "root"
                        }
                        // root / superadmin 不能被改（被查看者是 root/superadmin 时锁定）；非 root 操作者也不能改角色
                        disabled={
                          busy ||
                          detail.user.username === user?.username ||
                          detail.user.role === "root" ||
                          detail.user.role === "superadmin" ||
                          user?.role !== "root"
                        }
                        onCheckedChange={(v) =>
                          void handleToggleRole(v ? "admin" : "user")
                        }
                      />
                    </div>
                  </div>

                  {/* 重置二次认证：只有站长能做，是「管理员被 2FA 挡在门外」时的唯一出路 */}
                  {user?.role === "root" && (
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{t("adm.1254")}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {t("adm.1258")}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => void handleResetTwoFactor()}
                      >
                        {t("adm.1259")}
                      </Button>
                    </div>
                  )}

                  {/* 重置密码：同样只有站长能做（后端 rootOnly）。
                      与「重置二次认证」同级危险 —— 重置后对方全部会话失效，
                      必须用新密码重登，所以沿用同一套琥珀色警示样式。 */}
                  {user?.role === "root" && (
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{t("adm.pw.title")}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {t("adm.pw.hint")}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => {
                          // 每次打开都清空，避免上一次输入的密码留在框里
                          setPwValue("")
                          setPwShow(false)
                          setPwOpen(true)
                        }}
                      >
                        {t("adm.pw.action")}
                      </Button>
                    </div>
                  )}
                </section>

                {/* ---- 邀请码额度 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.867")}</h3>
                  <div className="rounded-md border p-3 text-xs">
                    <p className="text-muted-foreground">
                      {t("adm.inviteQuotaOnly", {
                        total: detail.quota.inviteTotal,
                        base: detail.quota.inviteBase,
                        used: detail.quota.inviteUsed,
                        left: detail.quota.inviteRemaining,
                      })}
                    </p>
                  </div>
                </section>

                {/* ---- 最近活动（首屏 20 条，更多懒加载） ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    {t("adm.1174", { v0: detail.activity.length + activityExtra.length })}
                  </h3>
                  <div className="rounded-md border">
                    {detail.activity.length + activityExtra.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">{t("adm.868")}</p>
                    ) : (
                      [...detail.activity, ...activityExtra].map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center justify-between border-b px-3 py-2 text-xs last:border-b-0"
                        >
                          <span className="truncate">{a.detail || a.action}</span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            {fmtTime(a.createdAt)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  {activityHasMore && (
                    <div className="mt-2 flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadMoreActivity()}
                        disabled={activityBusy}
                      >
                        {activityBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t("adm.1286")}
                      </Button>
                    </div>
                  )}
                </section>



                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.1177", { v0: detail.mailboxes.length })}</h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.mailboxes.map((mb) => (
                      <span
                        key={mb.id}
                        className="rounded-md border px-2.5 py-1 font-mono text-xs break-all"
                      >
                        {mb.address}
                        {mb.primary && (
                          <span className="ml-1 text-muted-foreground">{t("adm.870")}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.1178", { v0: detail.messages.length })}</h3>
                  <div className="rounded-md border">
                    {detail.messages.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">{t("adm.871")}</p>
                    ) : (
                      detail.messages.slice(0, 20).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-xs hover:bg-accent/50 last:border-b-0"
                          onClick={() => void openMessage(m.id)}
                        >
                          <span className="truncate font-medium">
                            {m.read ? "" : "● "}
                            {m.subject || t("adm.1179")}
                          </span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            {m.from}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.872")}</h3>
                  <div className="space-y-2">
                    {FEATURES.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center justify-between rounded-md border p-3"
                      >
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{t(f.label)}</p>
                          <p className="text-xs text-muted-foreground">{t(f.desc)}</p>
                        </div>
                        <Switch
                          checked={detail.user.permissions[f.key]}
                          disabled={busy || detail.user.username === user?.username}
                          onCheckedChange={(v) =>
                            void handleTogglePermission(f.key, v)
                          }
                        />
                      </div>
                    ))}
                  </div>
                </section>

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleToggleStatusByName(
                        detail.user.username,
                        detail.user.status
                      )
                    }
                    disabled={busy || detail.user.username === user?.username}
                  >
                    {detail.user.status === "active" ? (
                      <>
                        <Ban className="h-3.5 w-3.5" />
                        {t("adm.876")}
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-3.5 w-3.5" />
                        {t("adm.877")}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 会员银行卡号：与用户详情分开的弹窗（避免详情里再套一层 Dialog） */}
      {cardNoUser !== null && (
        <AdminUserCardNoDialog
          open
          onOpenChange={(v) => {
            if (!v) setCardNoUser(null)
          }}
          username={cardNoUser}
          cardNo={detail?.user.cardNo ?? null}
          memberLevel={detail?.user.memberLevel ?? 0}
          onSaved={() => void openDetail(cardNoUser)}
        />
      )}

      {/*
        重置密码（rootOnly）。刻意与用户详情分成两个独立弹窗，
        不在详情弹窗里再叠一层：嵌套 Radix Dialog 的 Esc / 焦点会互相干扰，
        而且关闭时容易出现「关掉内层顺手把详情也关了」。
      */}
      <Dialog
        open={pwOpen}
        onOpenChange={(open) => {
          // 提交中不允许关闭：请求已发出，关掉会让站长以为没生效
          if (!open && !pwBusy) setPwOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adm.pw.title")}</DialogTitle>
            <DialogDescription>
              {t("adm.pw.confirm", { v0: detail?.user.username ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admNewPw">{t("adm.pw.label")}</Label>
            <div className="flex gap-2">
              <Input
                id="admNewPw"
                type={pwShow ? "text" : "password"}
                autoComplete="new-password"
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                placeholder={t("adm.pw.placeholder")}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setPwShow((v) => !v)}
              >
                {pwShow ? t("adm.pw.hide") : t("adm.pw.show")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("adm.pw.note")}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPwOpen(false)}
              disabled={pwBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleSetPassword()}
              disabled={pwBusy || pwValue.length < 8}
            >
              {pwBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("adm.pw.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 封禁原因（多行备注，替代原生 prompt） */}
      <Dialog
        open={suspendTarget !== null}
        onOpenChange={(open) => {
          if (!open && !suspendBusy) setSuspendTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("adm.suspendReasonTitle", { username: suspendTarget?.username ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("adm.suspendReasonDesc")}</DialogDescription>
          </DialogHeader>
          <Textarea
            rows={4}
            maxLength={300}
            autoFocus
            value={suspendReasonText}
            onChange={(e) => setSuspendReasonText(e.target.value)}
            placeholder={t("adm.suspendReasonPh")}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={suspendBusy}
              onClick={() => setSuspendTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={suspendBusy}
              onClick={() => {
                const reason = suspendReasonText.trim()
                if (!reason) {
                  toast.error(t("adm.suspendReasonRequired"))
                  return
                }
                if (!suspendTarget) return
                void (async () => {
                  setSuspendBusy(true)
                  await doToggleStatus(suspendTarget.username, suspendTarget.status, reason)
                  setSuspendBusy(false)
                  setSuspendTarget(null)
                })()
              }}
            >
              {t("adm.876")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量封禁 / 解封（用户列表多选模式；后端复用单人封禁的全部联动） */}
      <Dialog
        open={bulkAction !== null}
        onOpenChange={(open) => {
          if (!open && !bulkBusy) setBulkAction(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {bulkAction === "suspend" ? t("adm.sel.suspendTitle") : t("adm.sel.unsuspendTitle")}
            </DialogTitle>
            <DialogDescription>
              {bulkAction === "suspend"
                ? t("adm.sel.suspendDesc", { n: String(selectedUserIds.size) })
                : t("adm.sel.unsuspendDesc", { n: String(selectedUserIds.size) })}
            </DialogDescription>
          </DialogHeader>
          {bulkAction === "suspend" && (
            <Textarea
              rows={4}
              maxLength={300}
              autoFocus
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder={t("adm.suspendReasonPh")}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={bulkBusy}
              onClick={() => setBulkAction(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant={bulkAction === "suspend" ? "destructive" : "default"}
              disabled={bulkBusy}
              onClick={() => void submitBulkStatus()}
            >
              {bulkBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {bulkAction === "suspend" ? t("adm.876") : t("adm.sel.unsuspendConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 邮件全文 */}
      <Dialog
        open={openedMessage !== null}
        onOpenChange={(open) => {
          if (!open) setOpenedMessage(null)
        }}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {openedMessage && (
            <>
              <DialogHeader>
                <DialogTitle>{openedMessage.subject || t("adm.1183")}</DialogTitle>
                <DialogDescription>
                  {openedMessage.from} · {fmtTime(openedMessage.receivedAt)}
                </DialogDescription>
              </DialogHeader>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                {openedMessage.body || t("adm.1184")}
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>

    </div>
  )
}

/** 邀请码分类：未使用 / 部分使用 / 已使用 */
function inviteBucket(inv: AdminInvite): "unused" | "partial" | "used" {
  if (inv.usedCount <= 0) return "unused"
  if (inv.usedCount >= inv.maxUses) return "used"
  return "partial"
}

/** 邀请码列表每页条数（与用户/捐献列表一致） */
const INVITE_PAGE_SIZE = 50

const INVITE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "adm.1206" },
  { key: "unused", label: "adm.1207" },
  { key: "partial", label: "adm.1208" },
  { key: "used", label: "adm.1209" },
]

function filterInvites(list: AdminInvite[], filter: string): AdminInvite[] {
  if (!filter) return list
  return list.filter((inv) => inviteBucket(inv) === filter)
}
