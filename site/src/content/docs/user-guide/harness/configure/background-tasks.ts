import { createHarness } from '@strands-agents/harness'

async function policyExample() {
  // --8<-- [start:background_policy]
  const agent = await createHarness({
    backgroundTasks: {
      never: ['*'],
      maxConcurrency: 2,
    },
  })
  // --8<-- [end:background_policy]
}

async function disableExample() {
  // --8<-- [start:background_disable]
  const agent = await createHarness({ backgroundTasks: false })
  // --8<-- [end:background_disable]
}
