import { Effect } from "effect"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"
import { writeFile } from "fs/promises"
import { join } from "path"

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      })
      .option("export", {
        describe: "export stats to a file as 'json', 'csv', or 'md'",
        type: "string",
        choices: ["json", "csv", "md"],
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project)
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }

    yield* reportStats(stats, args.tools, modelLimit, args.export)
  }),
})

const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row))
})

const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
) {
  const svc = yield* Session.Service
  const sessions = yield* getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const messages = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        for (const message of messages) {
          if (message.info.role === "assistant") {
            const modelKey = `${message.info.providerID}/${message.info.modelID}`
            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += message.info.cost || 0

            if (message.info.tokens) {
              sessionModelUsage[modelKey].tokens.input += message.info.tokens.input || 0
              sessionModelUsage[modelKey].tokens.output +=
                (message.info.tokens.output || 0) + (message.info.tokens.reasoning || 0)
              sessionModelUsage[modelKey].tokens.cache.read += message.info.tokens.cache?.read || 0
              sessionModelUsage[modelKey].tokens.cache.write += message.info.tokens.cache?.write || 0
            }
          }

          for (const part of message.parts) {
            if (part.type === "tool" && part.tool) {
              sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
            }
          }
        }

        return {
          messageCount: messages.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  for (const result of results) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    sessionTotalTokens.push(result.sessionTotalTokens)

    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

export function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                       OVERVIEW                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Days", stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    COST & TOKENS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow("Input", formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Output", formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      MODEL USAGE                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  Messages", usage.messages.toLocaleString()))
      console.log(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
      console.log(renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      TOOL USAGE                        │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

// One deliberate export payload shared by json, csv and md, so all three
// describe the same numbers under the same names. Limits are applied here: an
// absent --tools/--models means "everything", not "nothing" — unlike the
// terminal renderer, where model output is opt-in.
export function shapeStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  return {
    meta: {
      generated_at: new Date().toISOString(),
      days: stats.days,
      // dateRange is seeded with Date.now()/0, so it is meaningless with no sessions.
      earliest: stats.totalSessions === 0 ? "" : new Date(stats.dateRange.earliest).toISOString(),
      latest: stats.totalSessions === 0 ? "" : new Date(stats.dateRange.latest).toISOString(),
    },
    overview: {
      sessions: stats.totalSessions,
      messages: stats.totalMessages,
      cost_usd: round(stats.totalCost, 4),
      cost_per_day_usd: round(stats.costPerDay, 4),
      tokens_per_session: round(stats.tokensPerSession),
      median_tokens_per_session: round(stats.medianTokensPerSession),
    },
    tokens: {
      input: stats.totalTokens.input,
      output: stats.totalTokens.output,
      reasoning: stats.totalTokens.reasoning,
      cache_read: stats.totalTokens.cache.read,
      cache_write: stats.totalTokens.cache.write,
      total:
        stats.totalTokens.input +
        stats.totalTokens.output +
        stats.totalTokens.reasoning +
        stats.totalTokens.cache.read +
        stats.totalTokens.cache.write,
    },
    models: Object.entries(stats.modelUsage)
      .sort(([, a], [, b]) => b.messages - a.messages)
      .slice(0, modelLimit)
      .map(([id, usage]) => ({
        id,
        messages: usage.messages,
        input: usage.tokens.input,
        output: usage.tokens.output,
        cache_read: usage.tokens.cache.read,
        cache_write: usage.tokens.cache.write,
        cost_usd: round(usage.cost, 4),
      })),
    tools: Object.entries(stats.toolUsage)
      .sort(([, a], [, b]) => b - a)
      .slice(0, toolLimit)
      .map(([name, calls]) => ({ name, calls })),
  }
}

type ExportPayload = ReturnType<typeof shapeStats>

// Aggregation emits NaN for empty datasets; JSON.stringify would turn that into
// null and CSV into the literal "NaN", so collapse it at the boundary.
function round(value: number, places = 2) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(places))
}

const writeExport = Effect.fn("Cli.stats.export.write")(function* (body: string, extension: string) {
  const target = join(process.cwd(), `opencode_stats_${Date.now()}.${extension}`)
  yield* Effect.promise(() => writeFile(target, body, "utf8"))
  process.stderr.write(`Wrote ${target}\n`)
})

export const jsonExportStats = Effect.fn("Cli.stats.export.json")(function* (
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
) {
  yield* writeExport(JSON.stringify(shapeStats(stats, toolLimit, modelLimit), null, 2) + "\n", "json")
})

export const csvExportStats = Effect.fn("Cli.stats.export.csv")(function* (
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
) {
  yield* writeExport(renderCsv(shapeStats(stats, toolLimit, modelLimit)), "csv")
})

export const mdExportStats = Effect.fn("Cli.stats.export.md")(function* (
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
) {
  yield* writeExport(renderMarkdown(shapeStats(stats, toolLimit, modelLimit)), "md")
})

// Tidy long format: one row per metric, so adding a metric adds rows rather than
// columns and a saved pivot keeps working.
export function renderCsv(data: ExportPayload) {
  const rows = ["scope,scope_id,metric,value"]
  const add = (scope: string, id: string, metric: string, value: number | string) =>
    rows.push([scope, csvField(id), metric, csvField(String(value))].join(","))
  for (const [metric, value] of Object.entries(data.meta)) add("meta", "", metric, value)
  for (const [metric, value] of Object.entries(data.overview)) add("overview", "", metric, value)
  for (const [metric, value] of Object.entries(data.tokens)) add("tokens", "", metric, value)
  for (const model of data.models) {
    for (const [metric, value] of Object.entries(model)) {
      if (metric === "id") continue
      add("model", model.id, metric, value)
    }
  }
  for (const tool of data.tools) add("tool", tool.name, "calls", tool.calls)
  return rows.join("\n") + "\n"
}

function csvField(value: string) {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

export function renderMarkdown(data: ExportPayload) {
  const n = (value: number) => value.toLocaleString("en-US")
  const window = data.meta.earliest ? ` · ${data.meta.earliest} → ${data.meta.latest}` : ""
  return [
    "# opencode usage stats",
    "",
    `Generated \`${data.meta.generated_at}\` · ${data.meta.days} day window${window}`,
    "",
    "## Overview",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Sessions | ${n(data.overview.sessions)} |`,
    `| Messages | ${n(data.overview.messages)} |`,
    `| Total cost | $${data.overview.cost_usd} |`,
    `| Avg cost/day | $${data.overview.cost_per_day_usd} |`,
    `| Avg tokens/session | ${n(data.overview.tokens_per_session)} |`,
    `| Median tokens/session | ${n(data.overview.median_tokens_per_session)} |`,
    "",
    "## Tokens",
    "",
    "| Metric | Tokens |",
    "| --- | ---: |",
    `| Input | ${n(data.tokens.input)} |`,
    `| Output | ${n(data.tokens.output)} |`,
    `| Reasoning | ${n(data.tokens.reasoning)} |`,
    `| Cache read | ${n(data.tokens.cache_read)} |`,
    `| Cache write | ${n(data.tokens.cache_write)} |`,
    `| **Total** | **${n(data.tokens.total)}** |`,
    "",
    "## Model usage",
    "",
    ...modelTable(data.models, n),
    "## Tool usage",
    "",
    ...toolTable(data.tools, n),
  ].join("\n")
}

function modelTable(models: ExportPayload["models"], n: (value: number) => string) {
  if (models.length === 0) return ["_No model usage recorded._", ""]
  return [
    "| Model | Messages | Input | Output | Cache read | Cache write | Cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...models.map(
      (model) =>
        `| \`${model.id}\` | ${n(model.messages)} | ${n(model.input)} | ${n(model.output)} | ` +
        `${n(model.cache_read)} | ${n(model.cache_write)} | $${model.cost_usd} |`,
    ),
    "",
  ]
}

function toolTable(tools: ExportPayload["tools"], n: (value: number) => string) {
  if (tools.length === 0) return ["_No tool usage recorded._", ""]
  return ["| Tool | Calls |", "| --- | ---: |", ...tools.map((tool) => `| \`${tool.name}\` | ${n(tool.calls)} |`), ""]
}

// Returns an Effect rather than running the work, so the CLI handler's runtime
// awaits the write. Every branch stays lazy: a missing `yield*` must skip the
// table too, not silently skip only the export.
export function reportStats(
  stats: SessionStats,
  toolLimit?: number,
  modelLimit?: number,
  format?: string,
): Effect.Effect<void, CliError> {
  switch (format) {
    case "csv":
      return csvExportStats(stats, toolLimit, modelLimit)
    case "md":
      return mdExportStats(stats, toolLimit, modelLimit)
    case "json":
      return jsonExportStats(stats, toolLimit, modelLimit)
    default:
      return Effect.sync(() => displayStats(stats, toolLimit, modelLimit))
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
