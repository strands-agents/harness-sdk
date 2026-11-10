import { Agent, BedrockModel } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { updateCanvasTool } from './tools'
import { marked } from 'marked'

marked.use({ async: false })

const messagesDiv = document.getElementById('messages')!
const inputForm = document.getElementById('input-area') as HTMLFormElement
const userInput = document.getElementById('user-input') as HTMLInputElement
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
const settingsModal = document.getElementById('settings-modal')!
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement
const saveSettingsBtn = document.getElementById('save-settings-btn') as HTMLButtonElement
const cancelSettingsBtn = document.getElementById('cancel-settings-btn') as HTMLButtonElement

const openaiKeyInput = document.getElementById('openai-key') as HTMLInputElement
const anthropicKeyInput = document.getElementById('anthropic-key') as HTMLInputElement
const bedrockRegionInput = document.getElementById('bedrock-region') as HTMLInputElement
const bedrockAccessKeyInput = document.getElementById('bedrock-access-key') as HTMLInputElement
const bedrockSecretKeyInput = document.getElementById('bedrock-secret-key') as HTMLInputElement
const bedrockSessionTokenInput = document.getElementById('bedrock-session-token') as HTMLInputElement
const openaiFields = document.querySelector('.openai-fields') as HTMLElement
const anthropicFields = document.querySelector('.anthropic-fields') as HTMLElement
const bedrockFields = document.querySelector('.bedrock-fields') as HTMLElement

// In-memory credential storage — not persisted across page refreshes
let credentials: Record<string, string> = {}
let currentProvider = 'openai'

const WELCOME_HTML =
  '<div class="message agent">Hello! I can modify the canvas on the left. 👈<br />Try asking me "change background to blue" or "make it a circle".</div>'

function showToast(message: string): void {
  const toast = document.createElement('div')
  toast.textContent = message
  toast.style.cssText =
    'position:fixed;top:2rem;left:50%;transform:translateX(-50%);background:#1d1d1f;color:white;padding:1rem 2rem;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:2000;'
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
}

function toggleProviderFields(provider: string): void {
  openaiFields.classList.toggle('show', provider === 'openai')
  anthropicFields.classList.toggle('show', provider === 'anthropic')
  bedrockFields.classList.toggle('show', provider === 'bedrock')
}

function addMessage(role: 'user' | 'agent' | 'tool', text: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = `message ${role}`
  div.textContent = text
  messagesDiv.appendChild(div)
  messagesDiv.scrollTop = messagesDiv.scrollHeight
  return div
}

function getModel(): BedrockModel | AnthropicModel | OpenAIModel {
  if (currentProvider === 'bedrock') {
    return new BedrockModel({
      region: credentials['bedrock_region'] || 'us-west-2',
      clientConfig: {
        credentials: {
          accessKeyId: credentials['bedrock_access_key'],
          secretAccessKey: credentials['bedrock_secret_key'],
          ...(credentials['bedrock_session_token'] && {
            sessionToken: credentials['bedrock_session_token'],
          }),
        },
      },
    })
  }

  if (currentProvider === 'anthropic') {
    return new AnthropicModel({
      apiKey: credentials['anthropic_api_key'],
      clientConfig: {
        dangerouslyAllowBrowser: true,
      },
    })
  }

  return new OpenAIModel({
    api: 'chat',
    apiKey: credentials['openai_api_key'],
    clientConfig: {
      dangerouslyAllowBrowser: true,
    },
  })
}

async function main(): Promise<void> {
  let agent: Agent

  function initializeAgent(): void {
    const model = getModel()
    agent = new Agent({
      model,
      systemPrompt: `You are a creative and helpful browser assistant. 
You can modify the html, script, and style of the canvas iframe on the page using the update_canvas tool.
Scripts run in the iframe context with access to document.body.
Always use the tool when the user asks for visual changes.
Be concise in your text responses.`,
      tools: [updateCanvasTool],
    })
  }

  // Disable input until agent is initialized
  userInput.disabled = true
  sendBtn.disabled = true

  // Show settings on load so user can enter credentials
  settingsModal.classList.add('show')
  toggleProviderFields(currentProvider)

  settingsBtn.addEventListener('click', () => {
    providerSelect.value = currentProvider
    openaiKeyInput.value = credentials['openai_api_key'] || ''
    anthropicKeyInput.value = credentials['anthropic_api_key'] || ''
    bedrockRegionInput.value = credentials['bedrock_region'] || 'us-west-2'
    bedrockAccessKeyInput.value = credentials['bedrock_access_key'] || ''
    bedrockSecretKeyInput.value = credentials['bedrock_secret_key'] || ''
    bedrockSessionTokenInput.value = credentials['bedrock_session_token'] || ''
    toggleProviderFields(currentProvider)
    settingsModal.classList.add('show')
  })

  cancelSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('show')
  })

  saveSettingsBtn.addEventListener('click', () => {
    currentProvider = providerSelect.value

    if (currentProvider === 'openai') {
      credentials['openai_api_key'] = openaiKeyInput.value
    } else if (currentProvider === 'anthropic') {
      credentials['anthropic_api_key'] = anthropicKeyInput.value
    } else {
      credentials['bedrock_region'] = bedrockRegionInput.value
      credentials['bedrock_access_key'] = bedrockAccessKeyInput.value
      credentials['bedrock_secret_key'] = bedrockSecretKeyInput.value
      credentials['bedrock_session_token'] = bedrockSessionTokenInput.value
    }

    settingsModal.classList.remove('show')

    try {
      initializeAgent()
      userInput.disabled = false
      sendBtn.disabled = false
      messagesDiv.innerHTML = WELCOME_HTML
      showToast('Settings saved!')
    } catch (err) {
      console.error(`error=<${err}> | failed to initialize agent`)
      userInput.disabled = true
      sendBtn.disabled = true
      showToast('Failed to initialize agent. Check your credentials.')
    }
  })

  providerSelect.addEventListener('change', (e) => {
    toggleProviderFields((e.target as HTMLSelectElement).value)
  })

  clearBtn.addEventListener('click', () => {
    messagesDiv.innerHTML = WELCOME_HTML
    if (agent) {
      agent.messages = []
    }
  })

  inputForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = userInput.value.trim()
    if (!text) return

    addMessage('user', text)
    userInput.value = ''
    userInput.disabled = true
    sendBtn.disabled = true

    const loader = addMessage('agent', '')
    loader.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>'

    try {
      let fullText = ''
      let messageDiv: HTMLDivElement | null = null

      for await (const event of agent.stream(text)) {
        if (loader.parentNode) loader.remove()
        if (event.type !== 'modelStreamUpdateEvent') continue
        const modelEvent = event.event

        if (modelEvent.type === 'modelContentBlockStartEvent') {
          if (modelEvent.start?.type === 'toolUseStart') {
            const toolMsg = addMessage('tool', `🛠️ Using tool: ${modelEvent.start.name}...`)
            toolMsg.style.fontSize = '0.8em'
            toolMsg.style.color = '#666'
          } else {
            fullText = ''
            messageDiv = addMessage('agent', '')
          }
        } else if (modelEvent.type === 'modelContentBlockDeltaEvent' && modelEvent.delta.type === 'textDelta') {
          if (!messageDiv) messageDiv = addMessage('agent', '')
          fullText += modelEvent.delta.text
          try {
            messageDiv.innerHTML = marked.parse(fullText) as string
          } catch {
            messageDiv.textContent = fullText
          }
          messagesDiv.scrollTop = messagesDiv.scrollHeight
        }
      }
    } catch (err) {
      console.error(err)
      addMessage('agent', 'Error: ' + (err as Error).message)
    } finally {
      userInput.disabled = false
      sendBtn.disabled = false
      userInput.focus()
    }
  })
}

main()
