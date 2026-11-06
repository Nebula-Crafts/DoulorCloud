/**
 * 公告列表的进程内共享缓存（2026-11-06）。
 *
 * 为什么需要：公告现在有两个消费方 —— 概览页「网站动态」卡片与全站公告弹窗
 * （`AnnouncementPopupGate`，挂在 dashboard 布局上）。两者都在进页面时请求
 * `GET /api/announcements`，不共享就会每次进站打两遍同一个接口。
 *
 * 缓存粒度是「一次页面加载」（模块级 promise）：刷新页面自然重取，
 * 后台发新公告后用户下次刷新就能看到，不需要额外的失效广播。
 */
import { announcementApi } from "@/services/api"
import type { Announcement } from "@/types"

let inflight: Promise<Announcement[]> | null = null

/** 取公告列表（同一次页面加载内复用同一个请求） */
export function loadAnnouncements(): Promise<Announcement[]> {
  if (!inflight) {
    inflight = announcementApi
      .list()
      .then((r) => r.announcements)
      .catch((err) => {
        // 失败不缓存，否则一次网络抖动会让整次会话都看不到公告
        inflight = null
        throw err
      })
  }
  return inflight
}

/** 强制下一次重新拉取（管理端发布后回到用户端验证时用得上） */
export function invalidateAnnouncements(): void {
  inflight = null
}