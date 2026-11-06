import { env } from "cloudflare:workers"
import { createSession, sessionCookie } from "../src/auth"
import { hashPassword, uuid } from "../src/crypto"
import { ADMIN_PERMISSIONS } from "../src/admin-permissions"

export interface TestUser {
  id: string
  username: string
  cookie: string  // 形如 "doulor_session=xxx"
}

/**
 * 权限树的**全部叶子 key**（由 `ADMIN_PERMISSIONS` 现算，不硬编码，权限树增删自动跟随）。
 *
 * 单级大类（没有 children 的，如 `feedback`）本身就是叶子；二级大类取 children 的 key。
 *
 * ⚠️ 其中三个 rootOnly 叶子（`users.role` / `users.password` / `users.2fa`）写进
 * `admin_scope` 也**不会**放行 —— `assertAdminScope` 对 rootOnly 节点先判断、且只认
 * `role='root'`（见 `worker/src/handlers/admin.ts`）。保留它们只是为了让这份「全量」
 * 名副其实；碰这三类接口的用例必须显式用 `role:"root"`。
 */
export const ALL_ADMIN_LEAF_KEYS: readonly string[] = ADMIN_PERMISSIONS.flatMap((cat) =>
  cat.children && cat.children.length > 0 ? cat.children.map((leaf) => leaf.key) : [cat.key]
)

/** 注册一个用户并返回带 session cookie 的请求头 */
export async function makeUser(opts: {
  username?: string
  role?: "user" | "admin" | "superadmin" | "root"
  /**
   * 邮箱是否已验证，默认 **true**。
   *
   * 为什么默认已验证（2026-10-02 改）：从这天起，未验证邮箱的账号在**写操作**上会被
   * `requireUser` 拦成 403 EMAIL_NOT_VERIFIED（门槛清单见 `worker/src/auth.ts` 的
   * `EMAIL_VERIFY_REQUIRED_PREFIXES`）。绝大多数测试关心的是业务逻辑本身，而不是
   * 这个门槛，所以默认给一个「已验证」的账号，避免几十个用例集体变红。
   *
   * 要测「未验证」的行为（例如邮箱门槛本身、未验证提示），显式传 `emailVerified: false`。
   */
  emailVerified?: boolean
  /**
   * 管理端权限域（落库到 `users.admin_scope`，JSON 数组字符串）。
   *
   * 背景（2026-10-13，迁移 `0119_admin_permissions.sql`）：`role='admin'` 不再等于「全权」，
   * 管理端每个接口都要查白名单（`requireAdminScope` / `assertAdminScope`）。而
   * `superadmin` / `root` 是 `isPrivileged()` 直接放行、不看白名单。
   *
   * 语义：
   *   * **不传** —— 当 `role === "admin"` 时默认写入**全量叶子权限域**
   *     （`ALL_ADMIN_LEAF_KEYS`）。这样绝大多数只关心业务逻辑的用例不会因为
   *     「忘了配权限」而在管理端接口上集体 403。对 user / superadmin / root 不写。
   *   * `null` —— 显式**不写**（落 NULL）：白名单为空 ⇒ 管理端接口一律
   *     403 `ADMIN_SCOPE_DENIED`。要测「没被授权的 admin 被拒」时用它。
   *   * 数组 —— 原样写进 `admin_scope`，用来测「有 A 权限、没有 B 权限」的越权边界。
   */
  adminScope?: string[] | null
} = {}): Promise<TestUser> {
  const username = opts.username ?? `u_${Math.random().toString(36).slice(2, 8)}`
  const id = uuid()
  const now = new Date().toISOString()
  const role = opts.role ?? "user"
  const adminScope: string | null =
    opts.adminScope === undefined
      ? (role === "admin" ? JSON.stringify(ALL_ADMIN_LEAF_KEYS) : null)
      : (opts.adminScope === null ? null : JSON.stringify(opts.adminScope))
  await env.DB.prepare(
    "INSERT INTO users (id, username, email, password_hash, namespace, role, status, email_verified, admin_scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)"
  ).bind(
    id, username, `${username}@doulor.cn`,
    await hashPassword("pass1234"), username,
    role, opts.emailVerified === false ? 0 : 1, adminScope, now, now
  ).run()
  const token = await createSession(env, id)
  return { id, username, cookie: sessionCookie(token) }
}

/** 构造带鉴权的 Request */
export function authRequest(
  user: TestUser,
  path: string,
  init: RequestInit = {}
): Request {
  const headers = new Headers(init.headers)
  headers.set("Cookie", user.cookie)
  return new Request(`https://cloud.doulor.cn${path}`, { ...init, headers })
}

/**
 * 直接写 app_settings（绕过管理接口）。
 * 用于测试那些「读库即时生效」的全局开关（如 open_features）。
 */
export async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, new Date().toISOString())
    .run()
}

/** 直接覆写某用户的 permissions JSON（显式卡权限用） */
export async function setPermissions(userId: string, json: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
    .bind(json, userId)
    .run()
}

/** 直接调本 Worker（SELF） */
export async function fetchSelf(req: Request): Promise<Response> {
  const SELF = (await import("cloudflare:test")).SELF
  return SELF.fetch(req)
}

/**
 * 直接造一条「用户商品」（owner_id 非空）用于测试。
 *
 * 2026-11-06 商城收敛后，用户上架通道已下线（`createUserProduct` / `reviewProduct`
 * 删除），但**订单状态机**（担保托管 / 交付守卫 / 售后 / 租期快照）仍要覆盖 ——
 * 那些测试只是需要一个「带卖家」的商品。这里直接落库，等价于历史存量数据。
 */
export async function seedUserProduct(
  owner: { id: string; username: string },
  input: {
    name?: string
    price: number
    delivery?: string
    stock?: number | null
    billingMode?: string
    rentalDays?: number | null
    deliveryParams?: Record<string, unknown> | null
  }
): Promise<string> {
  const { env } = await import("cloudflare:workers")
  const id = `up_${Math.random().toString(36).slice(2, 12)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO point_products
       (id, name, description, price, stock, delivery, delivery_params, enabled, sort,
        created_at, updated_at, owner_id, owner_name, review_status, reviewed_at,
        billing_mode, rental_days, category)
     VALUES (?, ?, '', ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, 'approved', ?, ?, ?, 'other')`
  )
    .bind(
      id,
      input.name ?? "测试用户商品",
      input.price,
      input.stock === undefined ? 10 : input.stock,
      input.delivery ?? "manual",
      input.deliveryParams ? JSON.stringify(input.deliveryParams) : null,
      now,
      now,
      owner.id,
      owner.username,
      now,
      input.billingMode ?? "one_time",
      input.rentalDays ?? null
    )
    .run()
  return id
}
