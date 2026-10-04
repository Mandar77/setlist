/**
 * Renders an estimate as markdown suitable for a PR comment.
 *
 * Sorted by percentage of allowance used, worst first, because the only question
 * anyone asks of this table is "what runs out first" — and that answer should be the
 * first row, not something to be found by scanning.
 */

import { gateFor, type Estimate, type Row } from './estimate.js'

const SCOPE_LABEL: Record<Row['scope'], string> = {
  aws: 'AWS',
  provider: 'provider',
  cloudfront: 'CloudFront',
}

function num(value: number): string {
  if (!Number.isFinite(value)) return '∞'
  if (value === 0) return '0'
  if (Math.abs(value) >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (Math.abs(value) >= 1) return value.toFixed(2).replace(/\.00$/, '')
  // Small numbers are the per-second ones; two significant figures keeps 0.0077 WCU
  // from rendering as 0.01 and looking like a rounding artefact.
  return value.toPrecision(2)
}

const pct = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(1)}%` : 'over')

/**
 * `>` the gate is a failure, `>` two thirds of it is worth seeing coming.
 *
 * Takes the estimate rather than a single percentage because the threshold depends on
 * the row: provider quotas are judged at `providerGatePct` (ADR-008). A report that
 * marked a row FAIL while the gate passed it — or the reverse — would be worse than no
 * report, since the table is what a reader trusts over the exit code.
 */
function mark(row: Row, estimate: Estimate): string {
  if (!row.modelled) return '·'
  const gate = gateFor(row.scope, estimate)
  if (row.pct > gate) return '**FAIL**'
  if (row.pct > gate * (2 / 3)) return 'watch'
  return 'ok'
}

export function toMarkdown(estimate: Estimate): string {
  const lines: string[] = []

  lines.push('## Free-tier estimate')
  lines.push('')

  if (estimate.bindsFirst !== undefined) {
    const first = estimate.bindsFirst
    lines.push(
      `**Binds first:** \`${first.limit}\` in ${first.env} at ${pct(first.pct)} of its ` +
        `allowance (${num(first.projected)} of ${num(first.allowance)} ${first.unit}).`,
    )
    lines.push('')
  }

  lines.push(`Gate is ${estimate.gatePct}% of an environment's share; the runtime sentinel`)
  lines.push(`throttles at ${estimate.tripPct}%. Percentages are of the share, not the`)
  lines.push('account-wide total — the unallocated reserve is what absorbs being wrong.')
  lines.push('')

  lines.push('| | Limit | Env | Scope | Projected | Allowance | Used | Confidence |')
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | --- |')
  for (const row of estimate.rows) {
    const projected = row.modelled ? num(row.projected) : '—'
    lines.push(
      `| ${mark(row, estimate)} | \`${row.limit}\` | ${row.env} | ` +
        `${SCOPE_LABEL[row.scope]} | ${projected} | ${num(row.allowance)} | ` +
        `${row.modelled ? pct(row.pct) : '—'} | ${row.confidence} |`,
    )
  }
  lines.push('')

  if (estimate.breaches.length > 0) {
    lines.push(
      `### Over the gate (${estimate.gatePct}% AWS, ${estimate.providerGatePct}% provider)`,
    )
    lines.push('')
    for (const row of estimate.breaches) {
      lines.push(
        `- \`${row.limit}\` in **${row.env}**: ${num(row.projected)} of ` +
          `${num(row.allowance)} ${row.unit} (${pct(row.pct)}), from ` +
          `${row.metrics.map(m => `\`${m}\``).join(', ')}`,
      )
    }
    lines.push('')
  }

  if (estimate.planDrift.length > 0) {
    lines.push('### The written-down forecast no longer matches the model')
    lines.push('')
    for (const drift of estimate.planDrift) {
      lines.push(
        `- ${drift.env} ${drift.what}: declared ${num(drift.declared)}, model implies ` +
          `${num(drift.computed)}. One of the two is stale.`,
      )
    }
    lines.push('')
  }

  if (estimate.unmodelled.length > 0) {
    lines.push('### Not modelled')
    lines.push('')
    lines.push('No metric meters these, so they are unforecast rather than safe:')
    lines.push('')
    for (const name of estimate.unmodelled) lines.push(`- \`${name}\``)
    lines.push('')
  }

  return lines.join('\n')
}
