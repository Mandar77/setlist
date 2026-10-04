/**
 * The AWS side of the kill switch: real clients behind the narrow interfaces.
 *
 * Everything that decides *what* to stop is in `kill-switch.ts` and is a pure function
 * over these interfaces. This file only knows how to ask AWS, which is why it has no
 * tests of its own worth writing — there is nothing here to get wrong except the API
 * shapes, and a test with a mocked SDK would be asserting the mock.
 *
 * The clients are constructed once at module load so a warm invocation reuses the
 * connection. That matters more here than usual: the kill switch runs when something is
 * already wrong, and a cold start spent negotiating TLS is a cold start spent spending.
 */

import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  PutFunctionConcurrencyCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda'
import {
  GetScheduleCommand,
  ListSchedulesCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler'

import type {
  AuditSink,
  CloudFrontControl,
  DistributionSummary,
  EventSourceMapping,
  FunctionSummary,
  KillRecord,
  LambdaControl,
  Schedule,
  SchedulerControl,
} from './kill-switch.js'

const lambdaClient = new LambdaClient({})
const schedulerClient = new SchedulerClient({})
const cloudFrontClient = new CloudFrontClient({})
const dynamoClient = new DynamoDBClient({})

export const lambdaControl: LambdaControl = {
  async listFunctions(): Promise<readonly FunctionSummary[]> {
    const summaries: FunctionSummary[] = []
    let marker: string | undefined
    do {
      const page = await lambdaClient.send(new ListFunctionsCommand({ Marker: marker }))
      for (const fn of page.Functions ?? []) {
        if (fn.FunctionName === undefined || fn.FunctionArn === undefined) continue
        // ListFunctions does not return tags, so each one costs a call. Acceptable: this
        // runs once per incident over a handful of functions, and the alternative —
        // matching on a name prefix — would throttle anything that happened to be
        // called `setlist-*` and miss anything that was not.
        const tags = await lambdaClient.send(new ListTagsCommand({ Resource: fn.FunctionArn }))
        summaries.push({ functionName: fn.FunctionName, tags: tags.Tags ?? {} })
      }
      marker = page.NextMarker
    } while (marker !== undefined)
    return summaries
  },

  async setReservedConcurrency(functionName: string, value: number): Promise<void> {
    await lambdaClient.send(
      new PutFunctionConcurrencyCommand({
        FunctionName: functionName,
        ReservedConcurrentExecutions: value,
      }),
    )
  },

  async listEventSourceMappings(): Promise<readonly EventSourceMapping[]> {
    const mappings: EventSourceMapping[] = []
    let marker: string | undefined
    do {
      const page = await lambdaClient.send(new ListEventSourceMappingsCommand({ Marker: marker }))
      for (const mapping of page.EventSourceMappings ?? []) {
        if (mapping.UUID === undefined || mapping.FunctionArn === undefined) continue
        mappings.push({
          uuid: mapping.UUID,
          // The ARN's last segment is the function name.
          functionName: mapping.FunctionArn.split(':').pop() ?? '',
          // "Enabled" and "Creating" both mean it will poll.
          enabled: mapping.State !== 'Disabled' && mapping.State !== 'Disabling',
        })
      }
      marker = page.NextMarker
    } while (marker !== undefined)
    return mappings
  },

  async disableEventSourceMapping(uuid: string): Promise<void> {
    await lambdaClient.send(new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false }))
  },
}

export const schedulerControl: SchedulerControl = {
  async listSchedules(): Promise<readonly Schedule[]> {
    const schedules: Schedule[] = []
    let token: string | undefined
    do {
      const page = await schedulerClient.send(new ListSchedulesCommand({ NextToken: token }))
      for (const summary of page.Schedules ?? []) {
        if (summary.Name === undefined) continue
        // The list response carries no target, so fetch the one detail that decides
        // whether this schedule is ours.
        const detail = await schedulerClient.send(
          new GetScheduleCommand({ Name: summary.Name, GroupName: summary.GroupName }),
        )
        const arn = detail.Target?.Arn
        schedules.push({
          name: summary.Name,
          enabled: detail.State !== 'DISABLED',
          targetFunctionName:
            arn === undefined || !arn.includes(':function:')
              ? null
              : (arn.split(':').pop() ?? null),
        })
      }
      token = page.NextToken
    } while (token !== undefined)
    return schedules
  },

  async disableSchedule(name: string): Promise<void> {
    const current = await schedulerClient.send(new GetScheduleCommand({ Name: name }))
    // UpdateSchedule replaces the whole schedule, so every field has to be echoed back.
    // Omitting one does not leave it alone; it clears it.
    await schedulerClient.send(
      new UpdateScheduleCommand({
        Name: name,
        GroupName: current.GroupName,
        ScheduleExpression: current.ScheduleExpression,
        FlexibleTimeWindow: current.FlexibleTimeWindow,
        Target: current.Target,
        State: 'DISABLED',
      }),
    )
  },
}

export const cloudFrontControl: CloudFrontControl = {
  async listDistributions(): Promise<readonly DistributionSummary[]> {
    const distributions: DistributionSummary[] = []
    let marker: string | undefined
    do {
      const page = await cloudFrontClient.send(new ListDistributionsCommand({ Marker: marker }))
      for (const item of page.DistributionList?.Items ?? []) {
        if (item.Id === undefined) continue
        distributions.push({
          id: item.Id,
          comment: item.Comment ?? '',
          enabled: item.Enabled ?? false,
        })
      }
      marker = page.DistributionList?.NextMarker
    } while (marker !== undefined)
    return distributions
  },

  async disableDistribution(id: string): Promise<void> {
    // Same read-modify-write shape as the scheduler, and the ETag is mandatory: without
    // it CloudFront rejects the update, which is a concurrency control rather than an
    // inconvenience.
    const current = await cloudFrontClient.send(new GetDistributionConfigCommand({ Id: id }))
    if (current.DistributionConfig === undefined) return
    await cloudFrontClient.send(
      new UpdateDistributionCommand({
        Id: id,
        IfMatch: current.ETag,
        DistributionConfig: { ...current.DistributionConfig, Enabled: false },
      }),
    )
  },
}

/** Writes the audit record to the single table. */
export function auditSink(tableName: string): AuditSink {
  return {
    async write(record: KillRecord): Promise<void> {
      await dynamoClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: 'KILL#' },
            sk: { S: record.at },
            reason: { S: record.reason },
            functionsThrottled: { SS: nonEmpty(record.functionsThrottled) },
            mappingsDisabled: { SS: nonEmpty(record.mappingsDisabled) },
            schedulesDisabled: { SS: nonEmpty(record.schedulesDisabled) },
            distributionsDisabled: { SS: nonEmpty(record.distributionsDisabled) },
            failures: { SS: nonEmpty(record.failures) },
          },
        }),
      )
    },
  }
}

/**
 * DynamoDB rejects an empty string set, so an empty list becomes a single marker.
 *
 * Found the hard way in the ETL work: the failure is a validation exception at write
 * time, which for the kill switch would mean losing the record of an incident because
 * nothing happened to fail.
 */
function nonEmpty(values: readonly string[]): string[] {
  return values.length === 0 ? ['none'] : [...values]
}
