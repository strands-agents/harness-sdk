import { createHarness } from '@strands-agents/harness'

async function backgroundPolicy() {
  // --8<-- [start:tasks_tune]
  const agent = await createHarness({
    backgroundTasks: {
      never: ['*'],
      maxConcurrency: 2,
    },
  })
  // --8<-- [end:tasks_tune]
}

async function backgroundDisable() {
  // --8<-- [start:tasks_off]
  const agent = await createHarness({ backgroundTasks: false })
  // --8<-- [end:tasks_off]
}
