import { Agent } from '@strands-agents/sdk'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'
import type { InjectionContext } from '@strands-agents/sdk/vended-plugins/context-injector'

// =====================
// Getting Started
// =====================

function gettingStarted() {
  // --8<-- [start:getting_started]
  const agent = new Agent({
    plugins: [
      new ContextInjector({
        renderContent: async () => `<now>${new Date().toISOString()}</now>`,
      }),
    ],
  })
  // --8<-- [end:getting_started]

  void agent
}
void gettingStarted

// =====================
// Inject before every turn
// =====================

function everyTurn() {
  // --8<-- [start:every_turn]
  const clock = new ContextInjector({
    name: 'clock',
    trigger: 'everyTurn', // inject before every model call, not just fresh user asks
    renderContent: async () => `<now>${new Date().toISOString()}</now>`,
  })
  // --8<-- [end:every_turn]

  void clock
}
void everyTurn

// =====================
// Predicate trigger reading app state
// =====================

function predicate() {
  // --8<-- [start:predicate]
  const injector = new ContextInjector({
    // Inject only when a tool stashed a flag in app state last turn.
    trigger: ({ appState }: InjectionContext) => appState.get('recallEnabled') === true,
    renderContent: async ({ messages }) =>
      `<context>${messages.length} turns so far</context>`,
  })
  // --8<-- [end:predicate]

  void injector
}
void predicate
