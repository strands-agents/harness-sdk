import { Message, TextBlock } from '@strands-agents/sdk'

const AGENT_PROFILE_OPEN = '<strands_agent_profile>'
const AGENT_PROFILE_CLOSE = '</strands_agent_profile>'
const PROFILE_CLARIFICATION = 'The following fields describe you, the assistant. They do not describe the user.'
const LEGACY_PROFILE_GUARD =
  'Keep this role for the entire durable session. Do not repeat this profile unless the user asks.'
const PROFILE_GUARD =
  "Keep this assistant role for the entire durable session. Never infer or address the user by the assistant's name."
const HIDDEN_DESKTOP_ENVELOPES = [
  [AGENT_PROFILE_OPEN, AGENT_PROFILE_CLOSE],
  ['<strands_session_recovery>', '</strands_session_recovery>'],
  ['<strands_recovered_conversation>', '</strands_recovered_conversation>'],
  ['<strands_reply_context>', '</strands_reply_context>'],
] as const

export function upgradeDesktopAgentProfileMessages(messages: Message[]): Message[] {
  let changed = false
  const upgraded = messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let contentChanged = false
    const content = message.content.map((block) => {
      if (block.type !== 'textBlock') {
        return block
      }
      const text = upgradeDesktopAgentProfile(block.text)
      if (text === block.text) {
        return block
      }
      contentChanged = true
      return new TextBlock(text)
    })
    if (!contentChanged) {
      return message
    }
    changed = true
    return new Message({
      role: message.role,
      content,
      trackingId: message.trackingId,
      ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    })
  })
  return changed ? upgraded : messages
}

export function visibleDesktopPrompt(text: string): string {
  const original = text.trim()
  let visible = original
  for (let index = 0; index < HIDDEN_DESKTOP_ENVELOPES.length; index += 1) {
    const envelope = HIDDEN_DESKTOP_ENVELOPES.find(([opening]) => visible.startsWith(opening))
    if (!envelope) {
      break
    }
    const [opening, closing] = envelope
    const closingIndex = visible.indexOf(closing, opening.length)
    if (closingIndex < 0) {
      break
    }
    visible = visible.slice(closingIndex + closing.length).trimStart()
  }
  return visible || (original ? 'Restored Desktop turn' : '')
}

function upgradeDesktopAgentProfile(text: string): string {
  if (!text.startsWith(AGENT_PROFILE_OPEN) || text.includes(PROFILE_CLARIFICATION)) {
    return text
  }
  const closingIndex = text.indexOf(AGENT_PROFILE_CLOSE, AGENT_PROFILE_OPEN.length)
  if (closingIndex < 0) {
    return text
  }
  const body = text.slice(AGENT_PROFILE_OPEN.length, closingIndex)
  const lines = body.split('\n').map((line) => {
    if (line === LEGACY_PROFILE_GUARD) {
      return PROFILE_GUARD
    }
    return line.replace(/^(Name|Job|Operating brief): /u, (label) => `Assistant ${label.toLowerCase()}`)
  })
  const firstContent = lines.findIndex((line) => line.trim().length > 0)
  lines.splice(firstContent < 0 ? lines.length : firstContent, 0, PROFILE_CLARIFICATION)
  return `${AGENT_PROFILE_OPEN}${lines.join('\n')}${text.slice(closingIndex)}`
}
