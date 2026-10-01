/**
 * The account bootstrap template, as data.
 *
 * This is the one artifact a human uploads by hand (SESSION-1 §4), and the only place
 * long-lived trust is established. Everything after it is deployed by CI through the
 * roles created here, with no stored credentials anywhere (ADR-005).
 *
 * Built as an object and rendered to YAML rather than hand-written, for one reason:
 * the deny list has to be checked against `infra/free-tier/budget.yaml`, and a test
 * that parses CloudFormation shorthand (`!Sub`, `!GetAtt`) to do it would be testing
 * its own YAML parser as much as the policy. As data, `infra/test/bootstrap.test.ts`
 * asserts against the same structures the template is rendered from.
 *
 * Intrinsics use the long form (`Fn::Sub`) because that is what survives a round trip
 * through plain YAML. CloudFormation treats the two forms identically.
 */

import { DENIED_ACTIONS, NOT_EXPRESSIBLE_IN_IAM } from './never-use-iam.js'

type Cfn = Record<string, unknown>

const sub = (template: string): Cfn => ({ 'Fn::Sub': template })
const ref = (name: string): Cfn => ({ Ref: name })
const getAtt = (resource: string, attribute: string): Cfn => ({
  'Fn::GetAtt': [resource, attribute],
})

/** The environments CI deploys, each with its own role and its own GitHub environment. */
export const DEPLOY_ENVIRONMENTS = ['dev', 'stage', 'prod'] as const

/**
 * Statements that deny the never-use list.
 *
 * Conditional denies are separate statements: a condition applies to the whole
 * statement, so folding `lambda:CreateFunction`-with-a-VPC in with the unconditional
 * denies would make every one of them conditional, and the list would stop working
 * without looking any different.
 */
function denyStatements(): Cfn[] {
  const unconditional = DENIED_ACTIONS.filter(rule => rule.condition === undefined)
  const conditional = DENIED_ACTIONS.filter(rule => rule.condition !== undefined)

  const statements: Cfn[] = [
    {
      Sid: 'DenyNeverUseServices',
      Effect: 'Deny',
      Action: [...new Set(unconditional.flatMap(rule => rule.actions))].sort(),
      Resource: '*',
    },
  ]

  for (const [index, rule] of conditional.entries()) {
    statements.push({
      Sid: `DenyNeverUseConditional${index}`,
      Effect: 'Deny',
      Action: [...rule.actions].sort(),
      Resource: '*',
      Condition: rule.condition,
    })
  }
  return statements
}

/**
 * The permission boundary.
 *
 * A boundary is an intersection, not an overlay: effective permissions are the identity
 * policy AND the boundary. So it opens with Allow `*` and then subtracts — a boundary
 * of denies alone would permit nothing at all, and the first symptom would be a deploy
 * that fails on its first API call.
 */
function boundaryPolicy(): Cfn {
  return {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: sub('setlist-zero-cost-boundary-${AWS::Region}'),
      Description:
        'Permission boundary for every Setlist role. Denies the never-use list in ' +
        'infra/free-tier/budget.yaml. The last line of defence: cdk-nag and KICS run ' +
        'in CI and can be skipped; this cannot.',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'AllowEverythingNotDeniedBelow', Effect: 'Allow', Action: '*', Resource: '*' },
          ...denyStatements(),
          {
            // Without this, a deploy role can create a role with no boundary and use it
            // to do everything the boundary forbids. A boundary that can be escaped is
            // decoration.
            Sid: 'DenyRoleCreationWithoutThisBoundary',
            Effect: 'Deny',
            Action: ['iam:CreateRole', 'iam:CreateUser'],
            Resource: '*',
            Condition: {
              StringNotEquals: {
                'iam:PermissionsBoundary': sub(
                  'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/setlist-zero-cost-boundary-${AWS::Region}',
                ),
              },
            },
          },
          {
            Sid: 'DenyBoundaryTampering',
            Effect: 'Deny',
            Action: [
              'iam:DeleteRolePermissionsBoundary',
              'iam:DeleteUserPermissionsBoundary',
              'iam:CreatePolicyVersion',
              'iam:DeletePolicy',
              'iam:SetDefaultPolicyVersion',
            ],
            Resource: sub(
              'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/setlist-zero-cost-boundary-${AWS::Region}',
            ),
          },
          {
            // Joining an Organization ends the free tier for the life of the account,
            // immediately and irreversibly (PED §1). It is the single most expensive
            // API call available here.
            Sid: 'DenyOrganizationMembership',
            Effect: 'Deny',
            Action: ['organizations:*', 'account:PutAlternateContact', 'account:CloseAccount'],
            Resource: '*',
          },
        ],
      },
    },
  }
}

/** What a deploy role may do. Narrower than the boundary; the boundary is the backstop. */
function deployPolicy(): Cfn {
  return {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: sub('setlist-deploy-${AWS::Region}'),
      Description: 'What CI may do when deploying Setlist. Bounded by the zero-cost boundary.',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'CloudFormationAndTheServicesWeUse',
            Effect: 'Allow',
            Action: [
              'cloudformation:*',
              'cloudfront:*',
              'cloudwatch:DeleteAlarms',
              'cloudwatch:DescribeAlarms',
              'cloudwatch:GetMetricStatistics',
              'cloudwatch:PutMetricAlarm',
              'cloudwatch:PutMetricData',
              'dynamodb:*',
              'lambda:*',
              'logs:*',
              's3:*',
              'sns:*',
              'sqs:*',
              'ssm:*',
              'states:*',
              'tag:*',
              'xray:*',
            ],
            Resource: '*',
          },
          {
            // Scoped by name rather than open: CDK needs to create execution roles, but
            // only Setlist's, and only with the boundary attached (enforced above).
            Sid: 'RolesForTheStacksOnly',
            Effect: 'Allow',
            Action: ['iam:*'],
            Resource: [
              sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/setlist-*'),
              sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/setlist-*'),
            ],
          },
          {
            Sid: 'ReadIdentity',
            Effect: 'Allow',
            Action: ['sts:GetCallerIdentity', 'iam:GetRole', 'iam:ListRoles', 'iam:GetPolicy'],
            Resource: '*',
          },
        ],
      },
    },
  }
}

/**
 * Trust policy for a role assumed from GitHub Actions.
 *
 * `sub` is matched with StringEquals against `environment:<env>`, never StringLike with
 * a wildcard. A trust policy of `repo:owner/name:*` is assumable from any branch in the
 * repository, including one opened by a fork's pull request — which is the standard way
 * this is got wrong, and it hands deploy credentials to anyone who can open a PR.
 */
function githubTrust(subject: string): Cfn {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: sub(
            'arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com',
          ),
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': sub(
              `repo:\${GitHubOwner}/\${GitHubRepo}:${subject}`,
            ),
          },
        },
      },
    ],
  }
}

function deployRole(env: string): Cfn {
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: `setlist-deploy-${env}`,
      // ASCII only: CloudFormation restricts IAM Description to printable Latin-1, and
      // cfn-lint rejects an em dash here (E3031). Comments in this file may use them;
      // strings that reach AWS may not.
      Description: `Assumed by GitHub Actions from the '${env}' environment. No long-lived keys exist.`,
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: githubTrust(`environment:${env}`),
      ManagedPolicyArns: [ref('DeployPolicy')],
      PermissionsBoundary: ref('ZeroCostBoundary'),
      Tags: [
        { Key: 'app', Value: 'setlist' },
        { Key: 'env', Value: env },
      ],
    },
  }
}

/** Everything in the template, in the order a reader wants to meet it. */
export function buildTemplate(): Cfn {
  const resources: Cfn = {
    GitHubOidcProvider: {
      Type: 'AWS::IAM::OIDCProvider',
      Condition: 'CreateOidcProvider',
      Properties: {
        Url: 'https://token.actions.githubusercontent.com',
        ClientIdList: ['sts.amazonaws.com'],
        // AWS validates this endpoint against its own trust store and no longer uses
        // the thumbprint, but the property is still required. The value is the
        // long-standing GitHub Actions root and is public.
        ThumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
        Tags: [{ Key: 'app', Value: 'setlist' }],
      },
    },

    ZeroCostBoundary: boundaryPolicy(),
    DeployPolicy: deployPolicy(),
  }

  for (const env of DEPLOY_ENVIRONMENTS) {
    resources[`DeployRole${env[0]!.toUpperCase()}${env.slice(1)}`] = deployRole(env)
  }

  resources['DiagnosticsRole'] = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: 'setlist-diagnostics',
      Description:
        'Read-only. ADR-005 forbids local AWS credentials, so this is how deployed ' +
        'state is inspected: by dispatching the diagnostics workflow.',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: githubTrust('environment:diagnostics'),
      ManagedPolicyArns: [sub('arn:${AWS::Partition}:iam::aws:policy/ReadOnlyAccess')],
      PermissionsBoundary: ref('ZeroCostBoundary'),
      Policies: [
        {
          PolicyName: 'deny-billed-reads',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                // ReadOnlyAccess includes these, and they are billed per call —
                // GetMetricData and Logs Insights especially. A read-only role that
                // costs money on every use is not the harmless thing it looks like.
                Sid: 'DenyBilledReadOperations',
                Effect: 'Deny',
                Action: [
                  'ce:GetCostAndUsage',
                  'ce:GetCostForecast',
                  'cloudwatch:GetMetricData',
                  'logs:StartQuery',
                ],
                Resource: '*',
              },
            ],
          },
        },
      ],
      Tags: [{ Key: 'app', Value: 'setlist' }],
    },
  }

  resources['BillingTopic'] = {
    Type: 'AWS::SNS::Topic',
    Properties: {
      TopicName: 'setlist-billing-alerts',
      DisplayName: 'Setlist billing',
      Subscription: [{ Endpoint: ref('AlertEmail'), Protocol: 'email' }],
      Tags: [{ Key: 'app', Value: 'setlist' }],
    },
  }

  resources['BillingTopicPolicy'] = {
    Type: 'AWS::SNS::TopicPolicy',
    Properties: {
      Topics: [ref('BillingTopic')],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowBudgetsToPublish',
            Effect: 'Allow',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'SNS:Publish',
            Resource: ref('BillingTopic'),
            Condition: {
              StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') },
            },
          },
          {
            Sid: 'AllowCostAnomalyDetectionToPublish',
            Effect: 'Allow',
            Principal: { Service: 'costalerts.amazonaws.com' },
            Action: 'SNS:Publish',
            Resource: ref('BillingTopic'),
          },
        ],
      },
    },
  }

  /** The policy a budget action attaches: stop deploying anything new. */
  resources['SpendStopPolicy'] = {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: {
      ManagedPolicyName: sub('setlist-spend-stop-${AWS::Region}'),
      Description:
        'Attached to the deploy roles by a budget action when spend appears. Denies ' +
        'creating anything new while leaving reads and deletes alone: the point is to ' +
        'stop the bleeding without blocking the cleanup.',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'StopCreatingThings',
            Effect: 'Deny',
            NotAction: [
              'cloudformation:Delete*',
              'cloudformation:Describe*',
              'cloudformation:List*',
              'dynamodb:Delete*',
              'dynamodb:Describe*',
              'lambda:Delete*',
              'lambda:Get*',
              'lambda:List*',
              'logs:Delete*',
              'logs:Describe*',
              's3:Delete*',
              's3:Get*',
              's3:List*',
              'sns:Delete*',
              'sns:Get*',
              'sns:List*',
              'sqs:Delete*',
              'sqs:Get*',
              'sqs:List*',
              'sts:GetCallerIdentity',
            ],
            Resource: '*',
          },
        ],
      },
    },
  }

  resources['BudgetActionRole'] = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: 'setlist-budget-action',
      Description: 'Assumed by AWS Budgets to attach the spend-stop policy.',
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') } },
          },
        ],
      },
      Policies: [
        {
          PolicyName: 'attach-spend-stop',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
                Resource: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/setlist-deploy-*'),
              },
            ],
          },
        },
      ],
      PermissionsBoundary: ref('ZeroCostBoundary'),
    },
  }

  const budgetActionDefinition = {
    IamActionDefinition: {
      PolicyArn: ref('SpendStopPolicy'),
      Roles: DEPLOY_ENVIRONMENTS.map(env => `setlist-deploy-${env}`),
    },
  }

  resources['ZeroSpendBudget'] = {
    Type: 'AWS::Budgets::Budget',
    Properties: {
      Budget: {
        BudgetName: 'setlist-zero-spend-actual',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: ref('ZeroSpendThresholdUsd'), Unit: 'USD' },
      },
      NotificationsWithSubscribers: [
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 1,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'SNS', Address: ref('BillingTopic') }],
        },
      ],
    },
  }

  resources['ZeroSpendAction'] = {
    Type: 'AWS::Budgets::BudgetsAction',
    Properties: {
      BudgetName: 'setlist-zero-spend-actual',
      NotificationType: 'ACTUAL',
      ActionType: 'APPLY_IAM_POLICY',
      // AUTOMATIC: real money has already been spent, and waiting for someone to read
      // an email is how a small bill becomes a large one.
      ApprovalModel: 'AUTOMATIC',
      ExecutionRoleArn: getAtt('BudgetActionRole', 'Arn'),
      ActionThreshold: { Value: 1, Type: 'PERCENTAGE' },
      Definition: budgetActionDefinition,
      Subscribers: [{ Type: 'SNS', Address: ref('BillingTopic') }],
    },
    DependsOn: [
      'ZeroSpendBudget',
      ...DEPLOY_ENVIRONMENTS.map(e => `DeployRole${e[0]!.toUpperCase()}${e.slice(1)}`),
    ],
  }

  resources['ForecastBudget'] = {
    Type: 'AWS::Budgets::Budget',
    Properties: {
      Budget: {
        BudgetName: 'setlist-forecast',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: ref('ForecastThresholdUsd'), Unit: 'USD' },
      },
      NotificationsWithSubscribers: [
        {
          Notification: {
            NotificationType: 'FORECASTED',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'SNS', Address: ref('BillingTopic') }],
        },
      ],
    },
  }

  resources['ForecastAction'] = {
    Type: 'AWS::Budgets::BudgetsAction',
    Properties: {
      BudgetName: 'setlist-forecast',
      NotificationType: 'FORECASTED',
      ActionType: 'APPLY_IAM_POLICY',
      // MANUAL, unlike the actual-spend action above. A forecast is a projection, and
      // an early-month spike can forecast a month that never happens — locking out the
      // very deploy that would fix it. This arms the switch and waits for a click.
      ApprovalModel: 'MANUAL',
      ExecutionRoleArn: getAtt('BudgetActionRole', 'Arn'),
      ActionThreshold: { Value: 100, Type: 'PERCENTAGE' },
      Definition: budgetActionDefinition,
      Subscribers: [{ Type: 'SNS', Address: ref('BillingTopic') }],
    },
    DependsOn: [
      'ForecastBudget',
      ...DEPLOY_ENVIRONMENTS.map(e => `DeployRole${e[0]!.toUpperCase()}${e.slice(1)}`),
    ],
  }

  resources['AnomalyMonitor'] = {
    Type: 'AWS::CE::AnomalyMonitor',
    Properties: {
      MonitorName: 'setlist-all-services',
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    },
  }

  resources['AnomalySubscription'] = {
    Type: 'AWS::CE::AnomalySubscription',
    Properties: {
      SubscriptionName: 'setlist-anomalies',
      Frequency: 'IMMEDIATE',
      MonitorArnList: [ref('AnomalyMonitor')],
      Subscribers: [{ Type: 'SNS', Address: ref('BillingTopic') }],
      // Any anomaly at all. On an account whose whole premise is a $0 bill, the
      // interesting threshold is "anything".
      //
      // A JSON *string*, not a structure: the Cost Explorer API takes this expression
      // encoded, and CloudFormation passes it straight through (cfn-lint E3012).
      ThresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: ['1'],
        },
      }),
    },
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Setlist account bootstrap — GitHub OIDC trust, per-environment deploy roles, ' +
      'the zero-cost permission boundary, and the billing guardrails. Uploaded by hand ' +
      'once (docs/hitl/SESSION-1.md §4); everything after it is deployed by CI.',

    Metadata: {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'GitHub repository that may deploy' },
            Parameters: ['GitHubOwner', 'GitHubRepo', 'CreateOidcProviderParam'],
          },
          {
            Label: { default: 'Billing alerts' },
            Parameters: ['AlertEmail', 'ZeroSpendThresholdUsd', 'ForecastThresholdUsd'],
          },
        ],
        ParameterLabels: {
          GitHubOwner: { default: 'Your GitHub username or organisation' },
          GitHubRepo: { default: 'Repository name (setlist)' },
          AlertEmail: { default: 'Where billing alerts go — you must confirm the email' },
          CreateOidcProviderParam: {
            default: 'Create the GitHub OIDC provider? No if the account already has one',
          },
          ZeroSpendThresholdUsd: { default: 'Actual spend that trips the IAM deny (USD)' },
          ForecastThresholdUsd: { default: 'Forecast spend that arms the manual deny (USD)' },
        },
      },

      // Not decoration: `infra/test/bootstrap.test.ts` asserts this covers every
      // never_use entry in budget.yaml, so a reader of the template can see exactly
      // which guarantees IAM carries and which rest on the synth-time layers.
      SetlistNeverUse: {
        DeniedByThisBoundary: DENIED_ACTIONS.map(rule => ({
          Enforces: rule.enforces.source,
          Why: rule.why,
          Actions: rule.actions,
        })),
        NotExpressibleInIam: NOT_EXPRESSIBLE_IN_IAM.map(entry => ({
          Enforces: entry.enforces.source,
          Why: entry.why,
          CoveredBy: entry.coveredBy,
        })),
      },
    },

    Parameters: {
      GitHubOwner: {
        Type: 'String',
        Description: 'GitHub user or organisation that owns the repository.',
        AllowedPattern: '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$',
        ConstraintDescription: 'A GitHub username: letters, digits and single hyphens.',
      },
      GitHubRepo: {
        Type: 'String',
        Default: 'setlist',
        Description: 'Repository name. Only this repository can assume the deploy roles.',
        AllowedPattern: '^[A-Za-z0-9._-]{1,100}$',
      },
      AlertEmail: {
        Type: 'String',
        Description:
          'Billing alerts are sent here. AWS emails a confirmation link — until you ' +
          'click it the subscription is pending and the alarm fires into a void.',
        AllowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
        ConstraintDescription: 'Must be an email address.',
      },
      CreateOidcProviderParam: {
        Type: 'String',
        Default: 'Yes',
        AllowedValues: ['Yes', 'No'],
        Description:
          'An account can hold only one provider per URL. Choose No if this account ' +
          'already trusts GitHub Actions, or the stack fails with EntityAlreadyExists.',
      },
      ZeroSpendThresholdUsd: {
        Type: 'Number',
        Default: 1,
        MinValue: 1,
        Description:
          'Actual monthly spend that trips the automatic IAM deny. AWS Budgets rejects ' +
          'a limit below 1 USD, so the notification fires at 1% of it — a cent.',
      },
      ForecastThresholdUsd: {
        Type: 'Number',
        Default: 5,
        MinValue: 1,
        Description: 'Forecast monthly spend that arms the manual deny and emails you.',
      },
    },

    Conditions: {
      CreateOidcProvider: { 'Fn::Equals': [ref('CreateOidcProviderParam'), 'Yes'] },
    },

    Resources: resources,

    Outputs: {
      DeployRoleArnDev: {
        Description: 'Set as the AWS_DEPLOY_ROLE secret on the dev GitHub environment.',
        Value: getAtt('DeployRoleDev', 'Arn'),
      },
      DeployRoleArnStage: {
        Description: 'Set as the AWS_DEPLOY_ROLE secret on the stage GitHub environment.',
        Value: getAtt('DeployRoleStage', 'Arn'),
      },
      DeployRoleArnProd: {
        Description: 'Set as the AWS_DEPLOY_ROLE secret on the prod GitHub environment.',
        Value: getAtt('DeployRoleProd', 'Arn'),
      },
      DiagnosticsRoleArn: {
        Description: 'Set as AWS_DIAGNOSTICS_ROLE on the diagnostics GitHub environment.',
        Value: getAtt('DiagnosticsRole', 'Arn'),
      },
      BoundaryArn: {
        Description: 'The permission boundary every Setlist role must carry.',
        Value: ref('ZeroCostBoundary'),
      },
      BillingTopicArn: {
        Description: 'Confirm the email subscription on this topic before trusting alerts.',
        Value: ref('BillingTopic'),
      },
    },
  }
}
