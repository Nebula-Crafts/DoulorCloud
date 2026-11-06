import { describe, it, expect } from "vitest"
import { sanitizeUserText } from "../src/text-sanitize"

describe("sanitizeUserText", () => {
  it("删掉解码失败产生的替换字符（U+FFFD）", () => {
    expect(sanitizeUserText("外部应用「\uFFFD\uFFFD\uFFFD」", 100)).toBe("外部应用「」")
  })

  it("零宽字符与 BOM 一并清掉", () => {
    expect(sanitizeUserText("a\u200Bb\uFEFFc", 100)).toBe("abc")
  })

  it("控制字符换成空格并压缩连续空白", () => {
    expect(sanitizeUserText("  a\t\tb\n\nc  ", 100)).toBe("a b c")
  })

  it("按码点截断，不切坏 emoji", () => {
    const out = sanitizeUserText("😀😀😀", 2)
    expect(out).toBe("😀😀")
    // 关键：不能留下半个代理对（长度 2 的「😀」被切开会出现孤立 surrogate）
    expect(out.length).toBe(4)
    expect([...out].length).toBe(2)
  })

  it("非字符串输入返回空串", () => {
    expect(sanitizeUserText(undefined, 10)).toBe("")
    expect(sanitizeUserText(123 as unknown, 10)).toBe("")
    expect(sanitizeUserText(null, 10)).toBe("")
  })

  it("maxLength <= 0 时返回空串", () => {
    expect(sanitizeUserText("abc", 0)).toBe("")
  })

  it("正常中文原样保留", () => {
    expect(sanitizeUserText("积分兑换说明", 100)).toBe("积分兑换说明")
  })
})
