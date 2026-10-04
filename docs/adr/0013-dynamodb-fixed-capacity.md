# ADR-013 — DynamoDB capacity is fixed, not auto scaled

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decided by:** the human
- **Amends:** `infra/lib/stacks/platform-stack.ts`; adds Application Auto Scaling to the never-use list (PED §12, `infra/free-tier/budget.yaml`)
- **Context:** auto scaling creates CloudWatch alarms outside the template, where no gate can see them

## Context

`PlatformStack` provisions the single table with `Capacity.autoscaled({ minCapacity: 1,
maxCapacity: share })` on both read and write. The reasoning written next to it is that the
25 RCU / 25 WCU allowance is consumed by what is *provisioned*, so a table pinned at its
ceiling burns its share around the clock while one that scales to 1 when idle gives the
allowance back.

That trade is backwards, and it was bought with an allowance that is far scarcer.

### What it costs

Application Auto Scaling creates **CloudWatch alarms at runtime, in the account, not in the
template**. Its target-tracking policies are implemented as alarms, created by the service
after the stack deploys. The exact count is a property of the service rather than of our
code, which is the whole problem — it is not knowable from anything this repository holds.

The free allowance is **10 alarms account-wide**. `budget.yaml` already allocates 7 of them
(prod 5, stage 2, dev 0) and holds 3 in reserve. Six scaling policies — read and write, in
each of three environments — are enough to consume that reserve and run past 10, at which
point every further alarm is $0.10/month, forever, in the account this project exists to
keep at zero.

### Why nothing caught it

Both gates that exist to prevent precisely this are **template-shaped**:

- `SZC-ALARM-BUDGET` counts `AWS::CloudWatch::Alarm` resources in the synthesized template
  and fires on the ones past the environment's share.
- `never-use.test.ts` asserts against `Template.fromStack`.

An alarm a service creates after deploy appears in neither. The synthesized prod template
contains exactly 3 `AWS::CloudWatch::Alarm` resources and the gate is satisfied; the account
would hold those three plus however many Application Auto Scaling adds.

### And one of the gates was already asserting nothing

`never-use.test.ts`'s *"caps provisioned capacity at this environment ledger share"* iterates
`template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')`. **That returns zero
resources.** `TableV2` renders `AWS::DynamoDB::GlobalTable`, which carries auto scaling
*inline* — `ReadCapacityAutoScalingSettings` under `Replicas[0].ReadProvisionedThroughputSettings`,
and `WriteCapacityAutoScalingSettings` under the table's own `WriteProvisionedThroughputSettings`
— and emits no `ApplicationAutoScaling` resources at all. The loop has never had a body. The
test has passed since it was written, by looping over an empty set.

That makes this the seventh instrument in this repository found to report success while doing
nothing, and the first one found in the never-use suite itself. It also means a ban written
against `AWS::ApplicationAutoScaling::*` types would catch nothing here.

## Decision

1. **Remove Application Auto Scaling. Provision fixed capacity at the budgeted share.**
   The shares total **17 RCU and 17 WCU of 25** (prod 10, stage 4, dev 3), leaving 8 of each
   in reserve. Provisioned capacity inside the free allowance **is free whether it is used or
   not**, so pinning all three tables at their share costs nothing and leaves the reserve
   intact. The thing being conserved by scaling down was never scarce.

2. **`TableV2` cannot express this, and the reason is structural.** Verified in
   aws-cdk-lib 2.270.0: `Capacity.fixed()._renderWriteCapacity()` throws *"You cannot
   configure `writeCapacity` with FIXED capacity mode"*, because
   `CfnGlobalTable.WriteProvisionedThroughputSettingsProperty` has exactly one field,
   `writeCapacityAutoScalingSettings`. There is no `writeCapacityUnits` on a global table.
   (The read side has both, which is why only write is refused.)

   So fixed write capacity requires the **v1 `Table` construct**, which renders
   `AWS::DynamoDB::Table` and takes `readCapacity` / `writeCapacity` as plain numbers. Note
   what moves with it: **every rule, test and assertion keyed on
   `AWS::DynamoDB::GlobalTable` has to follow**, including `SZC-DDB-ONDEMAND`, `SZC-DDB-PITR`,
   the three DynamoDB tests in `never-use.test.ts` and the two in `platform.test.ts`. A
   type-keyed assertion that is not moved becomes another empty loop, which is the mistake
   this ADR is partly about.

   Losing global tables is not a loss: `never_use` already bans them.

3. **Application Auto Scaling joins the never-use list**, in all the places the parity tests
   tie together — `never_use` in `budget.yaml`, a cdk-nag rule, the KICS pack, and
   `never-use.test.ts`. The ban must catch **both shapes**: the
   `AWS::ApplicationAutoScaling::ScalableTarget` / `::ScalingPolicy` resource types, *and*
   `ReadCapacityAutoScalingSettings` / `WriteCapacityAutoScalingSettings` appearing anywhere
   in a DynamoDB resource's properties. Per the house rule, each is checked against a fixture
   that must fail as well as one that must pass — the existing test proves that a ban which
   only looks for the resource types would pass vacuously.

4. **The usage sentinel counts the account's alarms with `DescribeAlarms`** and reports
   against the allowance of 10. A template-shaped gate cannot see runtime-created alarms, and
   Application Auto Scaling is not the only service that makes them — so the fix is not only
   to remove this one cause but to start measuring the quantity itself.

   `DescribeAlarms` is a Describe/List call. It is not `GetMetricData` and not Logs Insights,
   so it stays inside the `CLAUDE.md` ban on per-call CloudWatch billing, which is the same
   reason the sentinel already uses `GetMetricStatistics`.

## Consequences

- **A fixed table cannot absorb a burst above its share; it throttles.** That is accepted,
  and for a $0 project it is the correct failure: a throttle is a retry, and scaling past the
  allowance is a bill. The ceiling was already the share — `maxCapacity` was set to exactly
  it — so auto scaling never bought headroom, only a faster approach to the same wall.
- **Idle environments now hold their capacity.** 17 of 25 units stand allocated at all times.
  This is a real change in what the account looks like and it is deliberate: the reserve of 8
  exists to absorb an estimate being wrong, not to be lent out between environments.
- **The alarm count becomes a measured number rather than an assumed one.** Until the sentinel
  reports it, nothing in this project knows how many alarms the account actually holds.
- **The vacuous capacity test gets a real assertion**, against whatever the new table type
  renders — and the fix is not complete until that test fails when the capacity is wrong.
