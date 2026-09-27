import { describe, expect, test } from "bun:test"
import { renderCsv, renderMarkdown, shapeStats, type SessionStats } from "../../src/cli/cmd/stats"

// A model id containing a comma and a quote exercises CSV field escaping without
// a separate contrived case.
const AWKWARD_MODEL = 'vendor/model,"v2"'

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalSessions: 7,
    totalMessages: 12,
    totalCost: 12.3456789,
    totalTokens: { input: 30467, output: 4336, reasoning: 512, cache: { read: 43008, write: 1024 } },
    toolUsage: { read: 14, bash: 9, edit: 3 },
    modelUsage: {
      "anthropic/claude-opus-5": {
        messages: 6,
        tokens: { input: 20000, output: 3000, cache: { read: 40000, write: 1000 } },
        cost: 9.87654,
      },
      [AWKWARD_MODEL]: {
        messages: 4,
        tokens: { input: 8000, output: 1000, cache: { read: 3000, write: 24 } },
        cost: 2.4691,
      },
      "opencode/big-pickle": {
        messages: 2,
        tokens: { input: 2467, output: 336, cache: { read: 8, write: 0 } },
        cost: 0,
      },
    },
    dateRange: { earliest: 1787788558233, latest: 1789411900040 },
    days: 19,
    costPerDay: 0.6497726,
    tokensPerSession: 11115.857142857143,
    medianTokensPerSession: 9000,
    ...overrides,
  }
}

const EMPTY: SessionStats = stats({
  totalSessions: 0,
  totalMessages: 0,
  totalCost: 0,
  totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  toolUsage: {},
  modelUsage: {},
  // aggregateSessionStats leaves these as NaN when it divides by zero sessions
  costPerDay: NaN,
  tokensPerSession: NaN,
  medianTokensPerSession: NaN,
  days: 0,
})

/** Quote-aware CSV row split, so escaped fields compare as single values. */
function parseCsv(body: string) {
  return body
    .trim()
    .split("\n")
    .map((line) => {
      const fields: string[] = []
      let field = ""
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (quoted && char === '"' && line[i + 1] === '"') {
          field += '"'
          i++
          continue
        }
        if (char === '"') {
          quoted = !quoted
          continue
        }
        if (char === "," && !quoted) {
          fields.push(field)
          field = ""
          continue
        }
        field += char
      }
      fields.push(field)
      return fields
    })
}

/** Every payload leaf keyed as scope|id|metric, the shape CSV rows take. */
function leaves(payload: ReturnType<typeof shapeStats>) {
  const out = new Map<string, string>()
  for (const section of ["meta", "overview", "tokens"] as const) {
    for (const [metric, value] of Object.entries(payload[section])) out.set(`${section}||${metric}`, String(value))
  }
  for (const model of payload.models) {
    for (const [metric, value] of Object.entries(model)) {
      if (metric === "id") continue
      out.set(`model|${model.id}|${metric}`, String(value))
    }
  }
  for (const tool of payload.tools) out.set(`tool|${tool.name}|calls`, String(tool.calls))
  return out
}

describe("stats export consistency", () => {
  test("csv carries exactly the payload's leaves, with identical values", () => {
    const payload = shapeStats(stats())
    const rows = parseCsv(renderCsv(payload))

    expect(rows[0]).toEqual(["scope", "scope_id", "metric", "value"])

    const actual = new Map(rows.slice(1).map((row) => [`${row[0]}|${row[1]}|${row[2]}`, row[3]]))
    expect(actual).toEqual(leaves(payload))
  })

  test("json round-trips the same payload csv was built from", () => {
    const payload = shapeStats(stats())
    // The json path writes JSON.stringify(shapeStats(...)), so a round-trip must
    // preserve every leaf csv reports.
    expect(leaves(JSON.parse(JSON.stringify(payload)))).toEqual(leaves(payload))
  })

  test("markdown states every payload number", () => {
    const payload = shapeStats(stats())
    // Thousands separators are presentation only; strip them rather than
    // reimplementing the formatter here.
    const flat = renderMarkdown(payload).replaceAll(",", "")
    for (const value of leaves(payload).values()) {
      if (value === "") continue
      expect(flat).toContain(value.replaceAll(",", ""))
    }
  })

  test("every format orders models and tools the same way", () => {
    const payload = shapeStats(stats())
    const expected = payload.models.map((model) => model.id)
    expect(expected).toEqual(["anthropic/claude-opus-5", AWKWARD_MODEL, "opencode/big-pickle"])

    const csvOrder = parseCsv(renderCsv(payload))
      .slice(1)
      .filter((row) => row[0] === "model" && row[2] === "messages")
      .map((row) => row[1])
    expect(csvOrder).toEqual(expected)

    const md = renderMarkdown(payload)
    const positions = expected.map((id) => md.indexOf(id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))

    expect(payload.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit"])
  })

  test("csv escapes a model id containing a comma and a quote", () => {
    const rows = parseCsv(renderCsv(shapeStats(stats())))
    for (const row of rows) expect(row).toHaveLength(4)
    expect(rows.some((row) => row[1] === AWKWARD_MODEL)).toBe(true)
  })

  test("limits apply identically across formats", () => {
    const payload = shapeStats(stats(), 2, 1)
    expect(payload.models).toHaveLength(1)
    expect(payload.tools).toHaveLength(2)

    const rows = parseCsv(renderCsv(payload)).slice(1)
    expect(new Set(rows.filter((row) => row[0] === "model").map((row) => row[1])).size).toBe(1)
    expect(rows.filter((row) => row[0] === "tool")).toHaveLength(2)

    const md = renderMarkdown(payload)
    expect(md).not.toContain("opencode/big-pickle")
    expect(md).not.toContain("| `edit` |")
  })

  test("absent limits export everything, unlike the terminal renderer", () => {
    const payload = shapeStats(stats())
    expect(payload.models).toHaveLength(3)
    expect(payload.tools).toHaveLength(3)
  })

  test("machine formats carry no human formatting", () => {
    const payload = shapeStats(stats())
    for (const row of parseCsv(renderCsv(payload)).slice(1)) {
      expect(row[3]).not.toContain("$")
      expect(row[3]).not.toContain(",")
      expect(row[3]).not.toMatch(/\d[KM]$/)
    }
    expect(JSON.stringify(payload)).not.toContain("$")
  })

  test("an empty dataset produces zeros, not NaN", () => {
    const payload = shapeStats(EMPTY)
    const json = JSON.stringify(payload)
    expect(json).not.toContain("NaN")
    expect(json).not.toContain("null")
    for (const value of Object.values(payload.overview)) expect(Number.isFinite(value)).toBe(true)

    // dateRange is seeded with Date.now()/0, so it must not surface as a 1970 date.
    expect(payload.meta.earliest).toBe("")
    expect(payload.meta.latest).toBe("")

    const rows = parseCsv(renderCsv(payload))
    expect(rows[0]).toEqual(["scope", "scope_id", "metric", "value"])
    expect(rows.slice(1).some((row) => row[0] === "model" || row[0] === "tool")).toBe(false)
    for (const row of rows.slice(1)) expect(row[3]).not.toBe("NaN")

    const md = renderMarkdown(payload)
    expect(md).toContain("_No model usage recorded._")
    expect(md).toContain("_No tool usage recorded._")
  })

  test("rounding happens once, so no format shows more precision than another", () => {
    const payload = shapeStats(stats())
    expect(payload.overview.cost_usd).toBe(12.3457)
    expect(payload.models[0].cost_usd).toBe(9.8765)
    // Every cost the payload holds must appear verbatim in markdown.
    const md = renderMarkdown(payload)
    expect(md).toContain(`$${payload.overview.cost_usd}`)
    expect(md).toContain(`$${payload.models[0].cost_usd}`)
  })
})
