/**
 * 富文本渲染（商品详情用，2026-11-06）。
 *
 * 与社区帖子用的 `<Markdown>` 是**两套策略**，别混用：
 *   · 社区帖子：用户内容 ⇒ 只认 Markdown，**拒绝内联 HTML**（react-markdown 默认行为）；
 *   · 商品描述：**只有管理员能写**（用户上架通道已下线）⇒ 放开内联 HTML，
 *     让站长能贴 `<div align="center">`、`<img>`、表格这类排版。
 *
 * 放开 HTML 不等于不管：过一遍 `rehype-sanitize`，白名单只留展示类标签，
 * `script` / `iframe` / `style` / `on*` 事件属性一律剔除，`href` / `src` 只认
 * http(s) 与 mailto。这样即便将来商品描述改由别处写入（导入、API），也不会变成 XSS 口子。
 */
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"

import { cn } from "@/lib/utils"

/** 在默认白名单上放开「排版常用」的几个标签与属性 */
const SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // 排版容器与对齐
    "div",
    "span",
    "figure",
    "figcaption",
    "small",
    "mark",
    "u",
    "details",
    "summary",
  ],
  attributes: {
    ...defaultSchema.attributes,
    // 只放开图片/链接必需的属性；**不放开 style**（能靠 CSS 盖住整页，甚至 position:fixed 钓鱼）
    img: [...(defaultSchema.attributes?.img ?? []), "src", "alt", "title", "width", "height"],
    a: [...(defaultSchema.attributes?.a ?? []), "href", "title", "target", "rel"],
    div: [...(defaultSchema.attributes?.div ?? []), "align"],
    p: [...(defaultSchema.attributes?.p ?? []), "align"],
    td: [...(defaultSchema.attributes?.td ?? []), "align", "colspan", "rowspan"],
    th: [...(defaultSchema.attributes?.th ?? []), "align", "colspan", "rowspan"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
}

export function RichContent({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div
      className={cn(
        // 基础排版：与社区帖子保持一致的观感
        "text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:my-4 [&_li]:my-1",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-2",
        // 图片：详情页里的图默认按容器宽度缩放，避免撑破布局
        "[&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-lg",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-1.5 [&_th]:border [&_th]:bg-muted/40 [&_th]:p-1.5",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
        components={{
          // 外链一律新标签打开，避免把用户带离详情页
          a: ({ href, children, ...props }) => (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}