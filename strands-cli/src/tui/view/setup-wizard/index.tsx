import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { Box, useInput, useStdout, useWindowSize, type DOMElement } from 'ink'
import type { HarnessAgentConfig } from '@strands-agents/harness'
import stringWidth from 'string-width'

import {
  PROVIDER_CREDENTIAL_KEYS,
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_LABELS,
  PROVIDER_IDS,
  type ProviderEnvironmentKey,
  type SetupConfiguration,
  type CliConfigStore,
  type ProviderId,
} from '../../config.js'
import { importAgentProject } from '../../project/import.js'
import { configurationFromStore, type AgentSetupSelection, type SetupChange } from '../../agent-configuration.js'
import type { ChatSettings } from '../../chat/types.js'
import type { SettingsCategory } from '../../settings.js'
import { DEFAULT_SETTINGS_CATEGORY, SETTINGS_CATEGORIES } from '../../settings.js'
import { parseMouseInput } from '../../terminal/mouse-input.js'
import { emptyEditor, graphemes, reduceInputSequence } from '../../terminal/composer.js'
import { errorMessage, sanitizeTerminalText } from '../../terminal/sanitize.js'
import { canChooseDirectory, chooseAgentProject, chooseDirectory } from '../../terminal/directory-picker.js'
import { setTerminalMouseMotion } from '../../terminal/terminal.js'
import {
  renderSetupGuideTransitionFrame,
  SETUP_GUIDE_TRANSITION_DURATION_MS,
  setupGuideLayout,
} from '../frog-intro-renderer.js'
import {
  elementAtMouse,
  elementContainsMouse,
  registerElement,
  mouseScrollDirection,
  scrollPanelViewport,
  revealPanelSelection,
  sliderOptionAtMouse,
} from '../interaction.js'
import { wrapLines } from '../presentation.js'
import { Text, ThemeProvider, useTheme } from '../theme.js'
import { BlinkingCursor, EditableText } from '../text-input.js'
import { CustomThemeEditor, type Appearance } from '../custom-theme-editor.js'
import { Fade, mixHexColors, useFadeTransition } from '../fade-in.js'

import {
  PROVIDERS,
  compatibleProfile,
  exaWebSearchActive,
  providerSupportsWebSearch,
  providerAssessment,
  providerFromModel,
  quickstartDraft,
} from './providers.js'
import { EXA_WEB_SEARCH_WARNING } from '../../builtin-tools.js'
import { memoryForDir } from './profile-fields.js'
import {
  APPEARANCE_STEP,
  appearanceSettings,
  MANUAL_STEPS,
  OPENING_CHOICES,
  rowsForStep,
  setupStepProgress,
  wizardSettingsRows,
} from './steps.js'
import { useBrandAnimation } from '../startup-view.js'
import { SetupBrand, setupBrandFrame } from './brand.js'
import { OpeningMenu } from './opening-menu.js'
import { SetupSettingsPanel, type SetupSettingsChoiceTarget } from './settings-panel.js'
import { EffortSlider } from '../model-panel.js'
import { ProviderList } from '../provider-list.js'
import { useProviderDiscovery, useProviderDiscoveryEffects } from './use-provider-discovery.js'
import type { AppearanceSettings, EditableField, SelectOption, SetupDraft, SetupFlow, WizardRow } from './types.js'
import { importPathCompletions } from './path-completion.js'
import { SetupProgress } from './progress.js'

type SetupAction = 'back' | 'next' | 'settings' | `browse:${number}`
type SetupControl =
  | number
  | SetupAction
  | 'search'
  | 'models-previous'
  | 'models-next'
  | `option:${number}`
  | `completion:${number}`
  | SetupSettingsChoiceTarget

export function SetupWizard(
  props: Omit<Parameters<typeof SetupWizardContent>[0], 'appearance' | 'setAppearance'>
): ReactElement {
  const [appearance, setAppearance] = useState(() =>
    appearanceSettings({ ...props.config.snapshot().settings, ...props.initialSettings })
  )
  return (
    <ThemeProvider settings={appearance}>
      <SetupWizardContent {...props} appearance={appearance} setAppearance={setAppearance} />
    </ThemeProvider>
  )
}

function SetupWizardContent({
  appearance,
  setAppearance,
  config,
  deferred = false,
  appearanceOnly = false,
  onComplete,
  onCancel,
  onAgentSetup,
  initialSettings,
}: {
  appearance: AppearanceSettings
  setAppearance: Dispatch<SetStateAction<AppearanceSettings>>
  config: CliConfigStore
  deferred?: boolean
  appearanceOnly?: boolean
  onComplete(change?: SetupChange): void
  onCancel?(exitCode: 0 | 130): void
  onAgentSetup?(selection: AgentSetupSelection): void
  initialSettings?: Partial<ChatSettings>
}): ReactElement {
  const { stdout } = useStdout()
  const { columns, rows: terminalRows } = useWindowSize()
  const [flow, setFlow] = useState<SetupFlow>()
  const [step, setStep] = useState(appearanceOnly ? APPEARANCE_STEP : 0)
  const [settingsReturn, setSettingsReturn] = useState<{
    flow: SetupFlow | undefined
    step: number
    selection: number
  }>()
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  const [panelSettings, setPanelSettings] = useState<ChatSettings>(() =>
    globalThis.structuredClone({ ...config.snapshot().settings, ...initialSettings })
  )
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const priorAppearance = useRef(appearance)
  const openAppearance = useCallback((): void => {
    priorAppearance.current = appearance
    setAppearanceOpen(true)
  }, [appearance])
  const previewAppearance = useCallback(
    (next: Appearance): void => {
      setAppearance((current) => ({ ...current, ...next }))
    },
    [setAppearance]
  )
  function closeAppearance(): void {
    setAppearance(priorAppearance.current)
    setAppearanceOpen(false)
  }
  const palette = useTheme()
  const { surface: COMMAND_DECK_BACKGROUND, panel: PANEL_BACKGROUND, selection: PANEL_SELECTION } = palette
  const panelTransition = useFadeTransition(appearance.animations)
  const [selection, setSelection] = useState(0)
  const [openingSelectionVisible, setOpeningSelectionVisible] = useState(false)
  const [hoveredControl, setHoveredControl] = useState<SetupControl>()
  const [focusedAction, setFocusedAction] = useState<SetupAction>()
  const [draft, setDraft] = useState<SetupDraft>(() => {
    const snapshot = config.snapshot()
    const settings = { ...snapshot.settings, ...initialSettings }
    return {
      providers: [...snapshot.providers.enabled],
      profile: snapshot.profile,
      permissionMode: snapshot.permissions.mode,
      allowedTools: [...snapshot.permissions.allow],
      customPermissions: snapshot.permissions.mode === 'default' && snapshot.permissions.allow.length > 0,
      settings: {
        mcpDiscovery: settings.mcpDiscovery,
        skillDiscovery: settings.skillDiscovery,
        agentMessaging: settings.agentMessaging,
      },
    }
  })
  const [setupTarget, setSetupTarget] = useState<SetupDraft>()
  const [profileBaseDir] = useState<string | null | undefined>(() => config.snapshot().profileBaseDir)
  const [importPath, setImportPath] = useState('')
  const [editing, setEditing] = useState<{ field: EditableField; value: string; cursor?: number }>()
  const [pathCompletionIndex, setPathCompletionIndex] = useState(-1)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const choosingDirectoryRef = useRef(false)
  const discovery = useProviderDiscovery(config)
  const {
    detectedEnvironment,
    providerEnvironment,
    setProviderEnvironment,
    awsDiscovery,
    ollamaDiscovery,
    liteLlmDiscovery,
    providerModels,
    effectiveEnvironment,
    readyProviders,
    recheck,
  } = discovery
  const [modelViewportStart, setModelViewportStart] = useState(0)
  const [modelQuery, setModelQuery] = useState('')
  const [modelSearchFocused, setModelSearchFocused] = useState(false)
  const [deselectedModel, setDeselectedModel] = useState<string>()
  const modelListElement = useRef<DOMElement | null>(null)
  const modelSearchElement = useRef<DOMElement | null>(null)
  const modelPreviousElement = useRef<DOMElement | null>(null)
  const modelNextElement = useRef<DOMElement | null>(null)
  const setupEffortSliderElement = useRef<DOMElement | null>(null)
  const [quickstartProvider, setQuickstartProvider] = useState<ProviderId>('bedrock')
  const [selecting, setSelecting] = useState<{
    field: ProviderEnvironmentKey
    options: readonly SelectOption[]
    selection: number
  }>()
  const [frogAnimationId, setFrogAnimationId] = useState<number>()
  const [agentHandoff, setAgentHandoff] = useState<AgentSetupSelection>()
  const [agentHandoffElapsedMs, setAgentHandoffElapsedMs] = useState(0)
  const agentHandoffDelivered = useRef(false)
  const rowElements = useRef(new Map<number, DOMElement>())
  const directoryElements = useRef(new Map<number, DOMElement>())
  const pathCompletionElements = useRef(new Map<number, DOMElement>())
  const selectOptionElements = useRef(new Map<number, DOMElement>())
  const choiceElements = useRef(new Map<SetupSettingsChoiceTarget, DOMElement>())
  const backElement = useRef<DOMElement | undefined>(undefined)
  const nextElement = useRef<DOMElement | undefined>(undefined)
  const settingsElement = useRef<DOMElement | undefined>(undefined)
  const frogElement = useRef<DOMElement | undefined>(undefined)
  const frogPress = useRef<{ column: number; row: number } | undefined>(undefined)
  const pressedElement = useRef<SetupControl | undefined>(undefined)
  const width = Math.max(1, columns)
  const height = Math.max(1, terminalRows)
  useEffect(() => {
    if (!agentHandoff || !onAgentSetup) {
      return
    }
    const duration = appearance.animations ? SETUP_GUIDE_TRANSITION_DURATION_MS : 0
    const startedAt = Date.now()
    const finish = (): void => {
      if (!agentHandoffDelivered.current) {
        agentHandoffDelivered.current = true
        onAgentSetup(agentHandoff)
      }
    }
    setAgentHandoffElapsedMs(duration === 0 ? SETUP_GUIDE_TRANSITION_DURATION_MS : 0)
    if (duration === 0) {
      finish()
      return
    }
    const timer = setInterval(() => {
      const elapsed = Math.min(duration, Date.now() - startedAt)
      setAgentHandoffElapsedMs(elapsed)
      if (elapsed >= duration) {
        clearInterval(timer)
        finish()
      }
    }, 32)
    return (): void => clearInterval(timer)
  }, [agentHandoff, appearance.animations, onAgentSetup])
  const navigationHeight = width < 32 ? 2 : 3
  const accent = palette.accent
  const pathEditing = editing?.field === 'importPath' ? editing : undefined
  const pathCompletions = useMemo(() => {
    if (
      !pathEditing ||
      (pathEditing.cursor ?? graphemes(pathEditing.value).length) !== graphemes(pathEditing.value).length
    ) {
      return []
    }
    return importPathCompletions(pathEditing.value)
  }, [pathEditing])
  const importCompletionCapacity = Math.min(pathCompletions.length, 4)
  useEffect(() => {
    setPathCompletionIndex(-1)
  }, [pathEditing?.value])
  const isAppearance = step === APPEARANCE_STEP
  const isSettings = isAppearance && settingsReturn !== undefined
  const progress = appearanceOnly || isSettings ? undefined : setupStepProgress(flow, step)
  const progressHeight = progress ? 3 : 0
  const updateAppearance = useCallback(
    (next: AppearanceSettings): void => {
      setAppearance(next)
      setPanelSettings((current) => ({ ...current, ...next }))
      if (isSettings) {
        setError(undefined)
        void config
          .setSettings(next)
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      }
    },
    [config, isSettings, setAppearance]
  )
  const updateSettings = useCallback(
    (next: ChatSettings): void => {
      setPanelSettings(next)
      setAppearance(appearanceSettings(next))
      setDraft((current) => ({
        ...current,
        settings: {
          ...current.settings,
          mcpDiscovery: next.mcpDiscovery,
          skillDiscovery: next.skillDiscovery,
          agentMessaging: next.agentMessaging,
        },
      }))
      setError(undefined)
      void config
        .setSettings(next)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    },
    [config, setAppearance]
  )
  const updateSetupSettings = useCallback(
    (next: ChatSettings): void => {
      setPanelSettings(next)
      setAppearance(appearanceSettings(next))
      setDraft((current) => ({
        ...current,
        settings: {
          ...current.settings,
          mcpDiscovery: next.mcpDiscovery,
          skillDiscovery: next.skillDiscovery,
          agentMessaging: next.agentMessaging,
        },
      }))
    },
    [setAppearance]
  )
  const isProviderSetup = (flow === 'quickstart' || flow === 'manual' || flow === 'agent') && step === 1
  const isTools = (flow === 'quickstart' && step === 2) || (flow === 'manual' && step === 3)
  const isPlugins = (flow === 'quickstart' && step === 3) || (flow === 'manual' && step === 4)
  const isCapabilities = isTools || isPlugins
  const isPermissions = flow === 'manual' && step === 6
  const isImport = flow === 'import' && step === 1
  const hasExternalActions =
    !isSettings && (isProviderSetup || isImport || isCapabilities || isAppearance || flow === 'manual')
  const bubbleWidth = Math.max(1, Math.min(isProviderSetup ? 144 : 112, width - 2))
  const lockupWidth = Math.max(1, width - 2)
  const brandFrame = setupBrandFrame(lockupWidth, height)
  const lockupHeight = brandFrame.height
  const showBrand = lockupHeight > 1
  const brandHeight = showBrand ? lockupHeight + 2 : 0
  const openingColumns = lockupWidth >= 64 ? 2 : 1
  const openingRows = Math.ceil(OPENING_CHOICES.length / openingColumns)
  const openingRowGap = openingColumns === 2 ? 2 : 1
  const openingContentHeight = height - brandHeight - navigationHeight - Number(error !== undefined)
  const openingTopGap =
    openingContentHeight >= openingRows * (openingColumns === 2 ? 9 : 5) + (openingRows - 1) * openingRowGap + 3
      ? 3
      : openingContentHeight >= openingRows * (openingColumns === 2 ? 8 : 5) + (openingRows - 1) * openingRowGap + 2
        ? 2
        : openingContentHeight >= openingRows * 3 + (openingRows - 1) * openingRowGap + 1
          ? 1
          : 0
  const openingButtonHeight = Math.max(
    1,
    Math.min(
      openingColumns === 2 ? 9 : 5,
      Math.floor((openingContentHeight - openingTopGap - (openingRows - 1) * openingRowGap) / openingRows)
    )
  )
  const actionHeight = height >= 20 ? 3 : 1
  const actionGap = height >= 24 ? 1 : 0
  const actionColumnGap = bubbleWidth >= 3 ? 1 : 0
  const actionWidth = Math.max(1, Math.floor((bubbleWidth - actionColumnGap) / 2))
  const splitQuickstart = isProviderSetup && bubbleWidth >= 38
  const quickstartProviderColumnWidth = Math.max(16, Math.min(31, Math.floor(bubbleWidth * 0.34)))
  const quickstartDetailColumnWidth = bubbleWidth - quickstartProviderColumnWidth - 2
  const rowHeight = isAppearance
    ? 2
    : isProviderSetup
      ? 4
      : isCapabilities
        ? 1
        : isPermissions
          ? 2
          : flow === 'manual'
            ? step === 2
              ? 5
              : step === 5
                ? 2
                : 3
            : 2
  const updateProfile = useCallback((update: Partial<HarnessAgentConfig>): void => {
    setDraft((current) => ({ ...current, profile: { ...current.profile, ...update } }))
  }, [])
  const credentialRejectedProvider =
    providerModels.provider === quickstartProvider &&
    !providerModels.loading &&
    providerModels.credentialRejected === true
      ? quickstartProvider
      : undefined
  const keyCredentialProvider = ['anthropic', 'openai', 'google'].includes(quickstartProvider)
  const credentialValidationProvider =
    isProviderSetup &&
    keyCredentialProvider &&
    readyProviders.includes(quickstartProvider) &&
    (providerModels.provider !== quickstartProvider || providerModels.loading)
      ? quickstartProvider
      : undefined
  const unavailableCredentialProvider = credentialRejectedProvider ?? credentialValidationProvider
  const setupReadyProviders = useMemo(
    () =>
      unavailableCredentialProvider
        ? readyProviders.filter((provider) => provider !== unavailableCredentialProvider)
        : readyProviders,
    [readyProviders, unavailableCredentialProvider]
  )

  const rows = useMemo<WizardRow[]>(() => {
    const stepRows = isAppearance
      ? wizardSettingsRows(
          { ...panelSettings, ...draft.settings, ...appearance },
          isSettings ? updateSettings : updateSetupSettings,
          openAppearance,
          'all'
        ).filter(({ section }) => section === settingsCategory)
      : rowsForStep(
          step,
          flow,
          draft,
          importPath,
          providerEnvironment,
          detectedEnvironment,
          quickstartProvider,
          setupReadyProviders,
          awsDiscovery,
          ollamaDiscovery,
          setDraft,
          updateProfile,
          setEditing,
          liteLlmDiscovery,
          credentialRejectedProvider,
          credentialValidationProvider,
          providerModels.error
        )
    return isProviderSetup
      ? [
          ...stepRows,
          {
            id: 'refresh-provider',
            label: '↻ Refresh',
            description: '',
            activate: (): void => {
              try {
                recheck()
                setError(undefined)
              } catch (error) {
                setError(errorMessage(error))
              }
            },
          },
        ]
      : stepRows
  }, [
    appearance,
    panelSettings,
    openAppearance,
    updateSetupSettings,
    updateSettings,
    isAppearance,
    isSettings,
    settingsCategory,
    isProviderSetup,
    awsDiscovery,
    detectedEnvironment,
    draft,
    flow,
    importPath,
    ollamaDiscovery,
    liteLlmDiscovery,
    providerEnvironment,
    quickstartProvider,
    setupReadyProviders,
    credentialRejectedProvider,
    credentialValidationProvider,
    providerModels.error,
    recheck,
    step,
    updateProfile,
  ])
  const selectedModelProvider = providerFromModel(draft.profile.model)
  const hasSelectedModel = deselectedModel !== draft.profile.model
  const canContinue =
    step !== 1 ||
    (flow === 'import'
      ? importPath.trim().length > 0
      : isProviderSetup
        ? hasSelectedModel &&
          selectedModelProvider === quickstartProvider &&
          setupReadyProviders.includes(quickstartProvider)
        : draft.providers.some((provider) => readyProviders.includes(provider)))
  const inspectedProvider = isProviderSetup ? quickstartProvider : undefined
  const inspectedAssessment = inspectedProvider
    ? providerAssessment(inspectedProvider, effectiveEnvironment, awsDiscovery, ollamaDiscovery, liteLlmDiscovery)
    : undefined
  const warning = keyCredentialProvider ? undefined : inspectedAssessment?.warning
  const assessmentFacts = inspectedAssessment?.facts ?? []
  const bannerWarning = warning
    ? assessmentFacts.length > 0
      ? [
          PROVIDER_LABELS[inspectedProvider!],
          ...assessmentFacts.map((fact) => `${fact.label}: ${fact.value}`),
          '',
          warning,
        ].join('\n')
      : `${PROVIDER_LABELS[inspectedProvider!]}: ${warning}`
    : isTools && exaWebSearchActive(draft.profile)
      ? EXA_WEB_SEARCH_WARNING
      : undefined
  const bannerWarningStatus = warning ? inspectedAssessment!.status : 'warning'
  const providerReady = isProviderSetup && setupReadyProviders.includes(quickstartProvider)
  const showProviderConfiguration = isProviderSetup && !providerReady
  const modelPanelVisible = splitQuickstart && providerReady
  const availableBubbleHeight = Math.max(
    1,
    height - brandHeight - progressHeight - (hasExternalActions ? actionHeight + actionGap : 0) - navigationHeight
  )
  const bannerLines = (text: string): string[] =>
    wrapLines(`⚠ ${text}`, Math.max(1, bubbleWidth - 4)).slice(
      0,
      Math.max(0, availableBubbleHeight - rowHeight - 1 - Number(error !== undefined))
    )
  const warningLines = bannerWarning && !splitQuickstart ? bannerLines(bannerWarning) : []
  // Reserve the Exa banner's space whether or not web_search is on, so toggling it doesn't resize the panel.
  const warningHeight =
    isTools && !warning && !providerSupportsWebSearch(draft.profile.model)
      ? bannerLines(EXA_WEB_SEARCH_WARNING).length
      : warningLines.length
  const warningGap = isCapabilities && warningHeight > 0 ? 1 : 0
  const extraRows = Number(error !== undefined) + warningGap + warningHeight
  const capabilityContentHeight = Math.max(0, rows.length - 1) * rowHeight + 2
  const bubbleHeight = isImport
    ? Math.min(9 + extraRows + importCompletionCapacity, availableBubbleHeight)
    : isCapabilities
      ? Math.min(capabilityContentHeight + extraRows, availableBubbleHeight)
      : isPermissions
        ? Math.min(9 + Math.max(0, rows.length - 3) * rowHeight + extraRows, availableBubbleHeight)
        : isAppearance
          ? availableBubbleHeight
          : flow === 'manual' && !isProviderSetup
            ? Math.min(rows.length * rowHeight + 3 + extraRows, availableBubbleHeight)
            : availableBubbleHeight
  const panelChromeHeight = isProviderSetup || isCapabilities ? 0 : isAppearance || flow === 'manual' ? 2 : 4
  const rowCapacity = isAppearance
    ? settingsCategory === 'Appearance' && bubbleHeight < 18
      ? 1
      : rows.length
    : Math.max(1, Math.floor((bubbleHeight - panelChromeHeight - extraRows) / rowHeight))
  const firstListRow = isCapabilities ? 1 : 0
  const viewportStart = Math.max(firstListRow, Math.min(selection - rowCapacity + 1, rows.length - rowCapacity))
  const visibleRows = rows.slice(viewportStart, viewportStart + rowCapacity)
  const hiddenRowsBefore = viewportStart
  const hiddenRowsAfter = Math.max(0, rows.length - viewportStart - visibleRows.length)
  const manualOverflowLabel = [
    hiddenRowsBefore > 0 ? `↑ ${hiddenRowsBefore} previous` : '',
    hiddenRowsAfter > 0 ? `↓ ${hiddenRowsAfter} more` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const visibleCapabilityRows = isCapabilities ? visibleRows.filter((row) => row.id !== 'select-all') : []
  const permissionToolCapacity = Math.max(1, Math.floor((bubbleHeight - 9 - extraRows) / rowHeight))
  const permissionViewportStart = Math.max(
    3,
    Math.min(selection - permissionToolCapacity + 1, rows.length - permissionToolCapacity)
  )
  const visiblePermissionTools = rows.slice(permissionViewportStart, permissionViewportStart + permissionToolCapacity)
  const providerRows = isProviderSetup ? rows.slice(0, PROVIDER_IDS.length) : []
  const providerFieldRows = isProviderSetup ? rows.slice(PROVIDER_IDS.length) : []
  const refreshRow = providerFieldRows.find((row) => row.id === 'refresh-provider')
  const providerConfigurationRows = providerFieldRows.filter((row) => row.id !== 'refresh-provider')
  const providerWarningStatus = providerConfigurationRows.some(
    (row) => row.input === true && PROVIDER_CREDENTIAL_KEYS.includes(row.field as ProviderEnvironmentKey)
  )
    ? 'error'
    : bannerWarningStatus
  const availableReasoningRow = providerConfigurationRows.find((row) => row.id === 'thinking')
  const selectedModelAvailable =
    hasSelectedModel &&
    providerModels.provider === quickstartProvider &&
    providerModels.available &&
    !providerModels.loading &&
    providerModels.models.some((model) => `${quickstartProvider}/${model.id}` === draft.profile.model)
  const reasoningRow = selectedModelAvailable ? availableReasoningRow : undefined
  const reasoningRowIndex = reasoningRow ? rows.indexOf(reasoningRow) : -1
  const hiddenReasoningRowIndex = availableReasoningRow && !reasoningRow ? rows.indexOf(availableReasoningRow) : -1
  const reasoningSlider =
    reasoningRow?.choices && reasoningRow.choices.length > 0
      ? {
          label: 'Effort',
          options: reasoningRow.choices.map((choice, index) => ({
            id: String(index),
            label: choice.label,
            ...(choice.active ? { active: true } : {}),
          })),
          ...(reasoningRow.disabled ? { disabled: true } : {}),
        }
      : undefined
  const showReasoningPanel = modelPanelVisible && reasoningSlider !== undefined && quickstartDetailColumnWidth >= 62
  const readyProviderControlRows = providerConfigurationRows.filter(
    (row) => row.id !== 'thinking' || (reasoningRow !== undefined && !showReasoningPanel)
  )
  const directoryRows = new Map(
    rows.flatMap((row, index) =>
      canChooseDirectory() && !row.disabled && (row.field === 'memoryDir' || row.field === 'skills')
        ? [[index, row.field] as const]
        : []
    )
  )
  const quickstartBodyHeight = bubbleHeight - panelChromeHeight - extraRows
  const providerFooterHeight = refreshRow ? 4 : 0
  const quickstartProviderListCapacity = Math.max(1, quickstartBodyHeight - 2 - providerFooterHeight)
  const quickstartProviderRowHeight =
    quickstartProviderListCapacity >= PROVIDER_IDS.length * 3 - 1
      ? 3
      : quickstartProviderListCapacity >= PROVIDER_IDS.length * 2
        ? 2
        : 1
  const quickstartProviderListHeight = Math.min(
    quickstartProviderListCapacity,
    PROVIDER_IDS.length * quickstartProviderRowHeight
  )
  const quickstartFieldRowHeight = 5
  const middleFacts = splitQuickstart && showProviderConfiguration ? assessmentFacts : []
  const middleFactsHeight = middleFacts.length
  const middleDetailGap = middleFacts.length > 0 && warning ? 1 : 0
  const middleFieldGap = warning && providerConfigurationRows.length > 0 ? 1 : 0
  const quickstartFieldReserve = providerConfigurationRows.length > 0 ? quickstartFieldRowHeight : 0
  const middleWarningLines =
    splitQuickstart && showProviderConfiguration && warning
      ? wrapLines(warning, quickstartDetailColumnWidth - 3).slice(
          0,
          Math.max(
            0,
            quickstartBodyHeight - quickstartFieldReserve - middleFactsHeight - middleDetailGap - middleFieldGap
          )
        )
      : []
  const middleDetailHeight = middleFactsHeight + middleDetailGap + middleWarningLines.length + middleFieldGap
  const quickstartFieldCapacity = Math.max(
    1,
    Math.floor((quickstartBodyHeight - middleDetailHeight) / quickstartFieldRowHeight)
  )
  const selectedField = providerConfigurationRows.findIndex((row) => row === rows[selection])
  const quickstartFieldViewportStart = Math.max(
    0,
    Math.min(selectedField - quickstartFieldCapacity + 1, providerConfigurationRows.length - quickstartFieldCapacity)
  )
  const visibleProviderFieldRows = providerConfigurationRows.slice(
    quickstartFieldViewportStart,
    quickstartFieldViewportStart + quickstartFieldCapacity
  )
  const filteredProviderModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return providerModels.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query))
  }, [modelQuery, providerModels.models])
  const quickstartModelOffset = rows.length
  const defaultModel =
    quickstartProvider === 'ollama' ? undefined : PROVIDERS[quickstartProvider].model(effectiveEnvironment)
  const quickstartDefaultModel = defaultModel?.slice(defaultModel.indexOf('/') + 1)
  const readyProviderControlsHeight = readyProviderControlRows.length * quickstartFieldRowHeight
  const quickstartModelRowHeight = 1
  const quickstartModelCapacity = Math.max(
    1,
    Math.floor((quickstartBodyHeight - 5 - readyProviderControlsHeight) / quickstartModelRowHeight)
  )
  const quickstartModelViewportStart = Math.max(
    0,
    Math.min(modelViewportStart, filteredProviderModels.length - quickstartModelCapacity)
  )
  const visibleProviderModels = filteredProviderModels.slice(
    quickstartModelViewportStart,
    quickstartModelViewportStart + quickstartModelCapacity
  )
  const previousModelCount = quickstartModelViewportStart
  const nextModelCount = Math.max(
    0,
    filteredProviderModels.length - quickstartModelViewportStart - visibleProviderModels.length
  )
  const showModelPagination =
    providerModels.provider === quickstartProvider && providerModels.available && visibleProviderModels.length > 0
  const quickstartModelContentWidth = Math.max(1, quickstartDetailColumnWidth - 4)
  const quickstartModelNameWidth = Math.min(
    Math.max(
      1,
      ...filteredProviderModels.map((model) => stringWidth(model.name) + (model.id === quickstartDefaultModel ? 2 : 0))
    ),
    Math.max(1, quickstartModelContentWidth - 15)
  )
  const quickstartModelIdWidth = Math.max(1, quickstartModelContentWidth - quickstartModelNameWidth - 3)
  const quickstartSelectableRows =
    rows.length + (modelPanelVisible && providerModels.available ? filteredProviderModels.length : 0)
  const controlBackground = (control: SetupControl, focused: boolean, disabled = false): string | undefined => {
    if (disabled || saving) {
      return undefined
    }
    return hoveredControl === control || focused ? PANEL_SELECTION : undefined
  }
  const rowBackground = (index: number): string | undefined => {
    return controlBackground(
      index,
      focusedAction === undefined && !modelSearchFocused && index === selection,
      rows[index]?.disabled
    )
  }
  const backHoverBackground = mixHexColors(
    COMMAND_DECK_BACKGROUND,
    palette.error,
    palette.mode === 'dark' ? 0.22 : 0.16
  )
  const nextHoverBackground = mixHexColors(
    COMMAND_DECK_BACKGROUND,
    palette.accent,
    palette.mode === 'dark' ? 0.22 : 0.16
  )

  // Sized from every row, not just the visible ones, so descriptions stay aligned while scrolling.
  const capabilityLabelWidth = Math.max(
    0,
    ...rows.filter((row) => row.id !== 'select-all').map((row) => graphemes(row.label).length)
  )
  const renderCapabilityRows = (capabilityRows: readonly WizardRow[]): ReactElement => (
    <Box flexGrow={1} paddingX={1} flexDirection="column" overflow="hidden">
      {capabilityRows.map((row) => {
        const index = rows.indexOf(row)
        return (
          <Box
            key={row.id}
            ref={(element) => registerElement(rowElements.current, index, element)}
            height={1}
            paddingX={1}
            flexShrink={0}
            backgroundColor={rowBackground(index)}
          >
            <Box width={capabilityLabelWidth + 4} flexShrink={0}>
              <Text color={row.active ? accent : palette.foreground} bold={index === selection} wrap="truncate-end">
                {row.active ? '☑' : '☐'} {row.label}
              </Text>
            </Box>
            <Text
              {...(row.descriptionColor ? { color: row.descriptionColor } : { dimColor: true })}
              wrap="truncate-end"
            >
              {row.description}
            </Text>
          </Box>
        )
      })}
    </Box>
  )

  const renderChoices = (choices: NonNullable<WizardRow['choices']>, index: number): ReactElement => (
    <Box flexWrap="wrap">
      {choices.map((choice, choiceIndex) => {
        const target = `choice:${index}:${choiceIndex}` as const
        return (
          <Box
            key={choice.label}
            ref={(element) => registerElement(choiceElements.current, target, element)}
            paddingX={1}
            marginRight={1}
            backgroundColor={controlBackground(target, choice.active)}
          >
            <Text bold={choice.active} {...(choice.active ? { color: accent } : {})}>
              {choice.label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )

  const renderRefreshButton = (row: WizardRow, fieldWidth: number, compact = false): ReactElement => {
    const index = rows.indexOf(row)
    const buttonWidth = Math.max(10, Math.floor(fieldWidth / 2))
    return (
      <Box
        key={row.id}
        height={compact ? 4 : quickstartFieldRowHeight}
        flexShrink={0}
        flexDirection="column"
        justifyContent={compact ? 'flex-end' : 'flex-start'}
        alignItems="center"
      >
        <Box
          ref={(element) => registerElement(rowElements.current, index, element)}
          width={buttonWidth}
          height={3}
          backgroundColor={rowBackground(index) ?? COMMAND_DECK_BACKGROUND}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          <Text bold color={index === selection ? accent : palette.foreground}>
            {row.label}
          </Text>
        </Box>
      </Box>
    )
  }

  const renderProviderField = (row: WizardRow, fieldWidth: number): ReactElement => {
    const index = rows.indexOf(row)
    const activeEditing = editing?.field === row.field ? editing : undefined
    const credential = PROVIDER_CREDENTIAL_KEYS.includes(row.field as ProviderEnvironmentKey)
    const editable = row.input === true
    return (
      <Box
        key={row.id}
        ref={(element) => registerElement(rowElements.current, index, element)}
        height={quickstartFieldRowHeight}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={credential && editable ? undefined : rowBackground(index)}
      >
        <Text bold {...(index === selection ? { color: accent } : {})} wrap="truncate-end">
          {row.label}
        </Text>
        {editable ? (
          <>
            <Box
              width={fieldWidth}
              height={3}
              paddingX={1}
              alignItems="center"
              backgroundColor={rowBackground(index) ?? COMMAND_DECK_BACKGROUND}
            >
              <EditableText
                value={activeEditing?.value ?? (row.selectOptions ? row.description : '')}
                cursor={activeEditing?.cursor ?? graphemes(activeEditing?.value ?? '').length}
                width={Math.max(1, fieldWidth - 4)}
                active={Boolean(activeEditing)}
                animate={appearance.animations}
                masked={credential}
              />
            </Box>
            {credential ? (
              <Text dimColor wrap="truncate-end">
                {row.description}
              </Text>
            ) : null}
          </>
        ) : row.choices?.length ? (
          renderChoices(row.choices, index)
        ) : activeEditing ? (
          <EditableText
            value={activeEditing.value}
            cursor={activeEditing.cursor ?? graphemes(activeEditing.value).length}
            width={Math.max(1, fieldWidth - 4)}
            active
            animate={appearance.animations}
          />
        ) : (
          <Text dimColor>{row.description || ' '}</Text>
        )}
      </Box>
    )
  }

  const renderProviderSelect = (state: NonNullable<typeof selecting>): ReactElement => {
    const capacity = Math.max(1, quickstartBodyHeight - middleDetailHeight - 3)
    const start = Math.max(0, Math.min(state.selection - capacity + 1, state.options.length - capacity))
    return (
      <Box
        width="100%"
        flexGrow={1}
        backgroundColor={PANEL_BACKGROUND}
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold wrap="truncate-end">
          {providerFieldRows.find((row) => row.field === state.field)?.label ?? 'Choose'}
        </Text>
        {state.options.slice(start, start + capacity).map((option, index) => {
          const optionIndex = start + index
          return (
            <Box
              key={`${option.label}:${option.value ?? 'custom'}`}
              ref={(element) => registerElement(selectOptionElements.current, optionIndex, element)}
              flexShrink={0}
              backgroundColor={controlBackground(`option:${optionIndex}`, optionIndex === state.selection)}
            >
              <Text {...(optionIndex === state.selection ? { color: accent } : {})} wrap="truncate-end">
                {optionIndex === state.selection ? '› ' : '  '}
                {option.label}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  function setProviderValue(field: ProviderEnvironmentKey, value: string): void {
    setProviderEnvironment((current) => {
      const next = { ...current }
      const normalized = value.trim()
      if (normalized) {
        next[field] = normalized
      } else {
        delete next[field]
      }
      return next
    })
    setError(undefined)
  }

  function focusNextProviderField(field: ProviderEnvironmentKey): void {
    const current = rows.findIndex((row) => row.field === field)
    const next = rows.findIndex((row, index) => index > current && !row.disabled)
    if (next >= 0) {
      setSelection(next)
      setFocusedAction(undefined)
    }
  }

  function chooseSelectOption(option: SelectOption): void {
    if (!selecting) {
      return
    }
    if (option.custom) {
      const current = providerEnvironment[selecting.field] ?? effectiveEnvironment[selecting.field]?.value ?? ''
      setEditing({ field: selecting.field, value: current })
    } else {
      setProviderValue(selecting.field, option.value ?? '')
      focusNextProviderField(selecting.field)
    }
    setSelecting(undefined)
  }

  const selectWizardRow = useCallback(
    (index: number): void => {
      setFocusedAction(undefined)
      setModelSearchFocused(false)
      setSelection(index)
      if (isProviderSetup && index >= quickstartModelOffset) {
        setModelViewportStart((start) =>
          revealPanelSelection(
            index - quickstartModelOffset,
            start,
            quickstartModelCapacity,
            filteredProviderModels.length
          )
        )
      }
      if (isProviderSetup && index >= 0 && index < PROVIDER_IDS.length) {
        if (PROVIDER_IDS[index] !== quickstartProvider) {
          setModelQuery('')
          setModelViewportStart(0)
          setDeselectedModel(undefined)
        }
        setQuickstartProvider(PROVIDER_IDS[index]!)
        setSelecting(undefined)
        setEditing(undefined)
      }
    },
    [isProviderSetup, quickstartModelOffset, quickstartModelCapacity, filteredProviderModels.length, quickstartProvider]
  )

  const updateModelQuery = (query: string): void => {
    setModelQuery(query)
    setModelSearchFocused(true)
    setFocusedAction(undefined)
    setModelViewportStart(0)
    setSelection(quickstartModelOffset)
    setHoveredControl(undefined)
  }

  function paginateModels(direction: -1 | 1): void {
    const lastPageStart = Math.max(0, filteredProviderModels.length - quickstartModelCapacity)
    const nextStart = Math.max(
      0,
      Math.min(lastPageStart, quickstartModelViewportStart + direction * quickstartModelCapacity)
    )
    setModelViewportStart(nextStart)
    setSelection(quickstartModelOffset + nextStart)
    setModelSearchFocused(false)
    setFocusedAction(undefined)
  }

  function browseForDirectory(field: 'importPath' | 'memoryDir' | 'skills'): void {
    if (choosingDirectoryRef.current) {
      return
    }
    choosingDirectoryRef.current = true
    setChoosingDirectory(true)
    setEditing(undefined)
    setError(undefined)
    const selection =
      field === 'importPath'
        ? chooseAgentProject()
        : chooseDirectory(
            field === 'memoryDir' ? 'Choose a directory for agent memory' : 'Choose a directory containing agent skills'
          )
    void selection
      .then((path) => {
        if (!path) return
        if (field === 'importPath') {
          setImportPath(path)
          setSelection(0)
        } else {
          updateProfile(field === 'skills' ? { skills: [path] } : { memory: memoryForDir(path) })
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        choosingDirectoryRef.current = false
        setChoosingDirectory(false)
      })
  }

  function chooseFlow(nextFlow: SetupFlow): void {
    panelTransition.transition(() => {
      setHoveredControl(undefined)
      setFocusedAction(undefined)
      setModelQuery('')
      setModelSearchFocused(false)
      setFlow(nextFlow)
      setStep(1)
      setError(undefined)
      if (nextFlow !== 'import') {
        if (nextFlow === 'agent') setSetupTarget(draft)
        const provider = providerFromModel(draft.profile.model) ?? 'bedrock'
        setQuickstartProvider(provider)
        setSelection(PROVIDER_IDS.indexOf(provider))
      } else {
        setSelection(0)
        setImportPath('')
      }
    })
  }

  function completeSetup(completedDraft: SetupDraft = draft, agentProject?: string): void {
    let saved: Promise<void>
    setSaving(true)
    if (appearanceOnly || agentProject) {
      if (deferred) {
        onComplete({
          configuration: {
            ...configurationFromStore(config),
            settings: { ...panelSettings, ...completedDraft.settings, ...appearance },
          },
          ...(agentProject ? { agentProject } : {}),
        })
        return
      }
      saved = appearanceOnly
        ? config.setSettings({ ...panelSettings, ...appearance })
        : config.useAgentProject(agentProject!, {
            ...panelSettings,
            ...completedDraft.settings,
            ...appearance,
          })
    } else {
      setError(undefined)
      const configuration: SetupConfiguration = {
        providers: completedDraft.providers,
        profile: compatibleProfile(completedDraft.profile),
        ...(profileBaseDir !== undefined ? { profileBaseDir } : {}),
        permissionMode: completedDraft.permissionMode,
        allowedTools:
          completedDraft.customPermissions || completedDraft.permissionMode === 'bypassPermissions'
            ? completedDraft.allowedTools
            : [],
        providerEnvironment,
        settings: { ...panelSettings, ...completedDraft.settings, ...appearance },
      }
      if (deferred) {
        onComplete({ configuration })
        return
      }
      saved = config.saveSetup(configuration)
    }
    void saved
      .then(() => onComplete())
      .catch((cause: unknown) => {
        setSaving(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  function continueFlow(): void {
    if (editing || selecting || saving) {
      return
    }
    if (step === 0) {
      chooseFlow(OPENING_CHOICES[selection]!.id)
      return
    }
    if (isAppearance) {
      completeSetup()
      return
    }
    if (flow === 'import') {
      try {
        const imported = importAgentProject(importPath)
        completeSetup(draft, imported.entrypoint)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      return
    }
    if (!canContinue) {
      setError('Select a provider with detected credentials; follow the provider setup instructions.')
      return
    }
    if (flow === 'agent') {
      if (!onAgentSetup || !setupTarget) {
        setError('Agent Q&A is not available in this setup session.')
        return
      }
      agentHandoffDelivered.current = false
      setAgentHandoffElapsedMs(0)
      setAgentHandoff({
        model: draft.profile.model,
        effort: compatibleProfile(draft.profile).effort,
        configuration: {
          profile: setupTarget.profile,
          permissionMode: setupTarget.permissionMode,
          allowedTools:
            setupTarget.customPermissions || setupTarget.permissionMode === 'bypassPermissions'
              ? setupTarget.allowedTools
              : [],
          providers: [...new Set([...setupTarget.providers, ...readyProviders])],
          providerEnvironment,
          settings: setupTarget.settings,
          ...(profileBaseDir !== undefined ? { profileBaseDir } : {}),
        },
      })
      return
    }
    if (flow === 'quickstart') {
      const provider = providerFromModel(draft.profile.model)
      if (!provider || !readyProviders.includes(provider)) {
        setError('The selected model provider needs setup.')
        panelTransition.transition(() => setStep(1))
        return
      }
      const completedDraft = {
        ...draft,
        providers: [provider, ...draft.providers.filter((candidate) => candidate !== provider)],
      }
      setDraft(completedDraft)
      if (step >= 3) {
        completeSetup(completedDraft)
        return
      }
      panelTransition.transition(() => {
        setStep(step + 1)
        setSelection(0)
        setFocusedAction(undefined)
        if (step === 1) {
          setModelSearchFocused(false)
        }
      })
      return
    }
    if (step < MANUAL_STEPS.length) {
      panelTransition.transition(() => {
        setStep((current) => current + 1)
        setFocusedAction(undefined)
        setSelection(0)
        setError(undefined)
        setModelSearchFocused(false)
      })
      return
    }
    const selectedProvider = providerFromModel(draft.profile.model)
    if (selectedProvider && !readyProviders.includes(selectedProvider)) {
      setError('The selected model provider needs setup.')
      panelTransition.transition(() => {
        setStep(1)
        setSelection(PROVIDER_IDS.indexOf(selectedProvider))
      })
      return
    }
    completeSetup()
  }

  function moveBack(): void {
    if (editing || selecting || saving) {
      return
    }
    setFocusedAction(undefined)
    if (isAppearance) {
      if (isSettings) {
        const destination = settingsReturn
        panelTransition.transition(() => {
          setFlow(destination.flow)
          setStep(destination.step)
          setSelection(destination.selection)
          setSettingsReturn(undefined)
          setError(undefined)
        })
        return
      }
      if (appearanceOnly) {
        onCancel?.(0)
      }
      return
    }
    if (step <= 1) {
      if (step === 0) {
        onCancel?.(0)
        return
      }
      panelTransition.transition(() => {
        if (flow === 'agent' && setupTarget) setDraft(setupTarget)
        setFlow(undefined)
        setStep(0)
        setSelection(0)
        setOpeningSelectionVisible(false)
        setError(undefined)
      })
      return
    }
    panelTransition.transition(() => {
      setStep((current) => current - 1)
      setSelection(step === 2 ? PROVIDER_IDS.indexOf(quickstartProvider) : 0)
      setError(undefined)
    })
  }

  function openSettings(): void {
    if (isAppearance) {
      return
    }
    panelTransition.transition(() => {
      setSettingsReturn({ flow, step, selection })
      setSettingsCategory(DEFAULT_SETTINGS_CATEGORY)
      setStep(APPEARANCE_STEP)
      setSelection(0)
      setFocusedAction(undefined)
      setError(undefined)
    })
  }

  function commitEdit(): boolean {
    if (!editing) {
      return true
    }
    const value = editing.value.trim()
    if (isProviderEnvironmentKey(editing.field)) {
      if (PROVIDER_CREDENTIAL_KEYS.includes(editing.field)) {
        if (!value) {
          setError('API key cannot be empty.')
          return false
        }
        try {
          config.setSessionProviderCredential(editing.field, value)
          recheck()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          return false
        }
      } else {
        setProviderValue(editing.field, value)
        focusNextProviderField(editing.field)
      }
      setEditing(undefined)
      setError(undefined)
      return true
    }
    if (!value && editing.field !== 'instructions') {
      setError('This field cannot be empty.')
      return false
    }
    if (editing.field === 'importPath') {
      setImportPath(value)
    } else if (editing.field === 'memoryDir') {
      updateProfile({ memory: memoryForDir(value) })
    } else if (editing.field === 'skills') {
      const paths = value
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean)
      // No directories keeps the library default (`true`) rather than turning skills off.
      updateProfile({ skills: paths.length === 0 ? true : paths })
    } else {
      updateProfile({ [editing.field]: value })
    }
    setEditing(undefined)
    setError(undefined)
    return true
  }

  function leaveEdit(): void {
    setEditing(undefined)
    setError(undefined)
  }

  function applyPathCompletion(index = pathCompletionIndex < 0 ? 0 : pathCompletionIndex): void {
    const completion = pathCompletions[index]
    if (!completion || !pathEditing) {
      return
    }
    setEditing({
      ...pathEditing,
      value: completion.value,
      cursor: graphemes(completion.value).length,
    })
    setError(undefined)
  }

  function activateRow(index: number): void {
    if (step === 0) {
      chooseFlow(OPENING_CHOICES[index]!.id)
      return
    }
    if (isImport && index === 1) {
      browseForDirectory('importPath')
      return
    }
    if (isProviderSetup && index >= quickstartModelOffset) {
      const model = filteredProviderModels[index - quickstartModelOffset]
      if (!model) {
        return
      }
      const profile = quickstartDraft(quickstartProvider, effectiveEnvironment).profile
      const modelSpecifier = `${quickstartProvider}/${model.id}`
      if (draft.profile.model === modelSpecifier && deselectedModel !== modelSpecifier) {
        setDeselectedModel(modelSpecifier)
        setError(undefined)
        return
      }
      setDeselectedModel(undefined)
      setDraft((current) => ({
        ...current,
        providers: [quickstartProvider, ...current.providers.filter((provider) => provider !== quickstartProvider)],
        profile: compatibleProfile({
          ...current.profile,
          effort: profile.effort,
          caching: profile.caching,
          model: modelSpecifier,
        }),
      }))
      setError(undefined)
      return
    }
    if (isProviderSetup && index < PROVIDER_IDS.length && !readyProviders.includes(PROVIDER_IDS[index]!)) {
      const fieldIndex = rows.findIndex((row) => row.field !== undefined && row.input === true)
      const field = rows[fieldIndex]
      if (fieldIndex >= PROVIDER_IDS.length && field) {
        setSelection(fieldIndex)
        field.activate()
      }
      return
    }
    const row = rows[index]
    if (!row || row.disabled) {
      return
    }
    if (editing && editing.field === row.field) {
      return
    }
    if (flow === 'manual' && step === MANUAL_STEPS.length) {
      const destination = [1, 2, 1, 3, 4, 5, 6][index]!
      panelTransition.transition(() => {
        setStep(destination)
        setSelection(destination === 1 ? PROVIDER_IDS.indexOf(quickstartProvider) : 0)
        setFocusedAction(undefined)
      })
      return
    }
    if (row.choices?.length) {
      const selected = row.choices.findIndex((choice) => choice.active)
      row.choices[(selected + 1) % row.choices.length]!.activate()
      return
    }
    if (row.selectOptions && row.field && isProviderEnvironmentKey(row.field)) {
      const current = providerEnvironment[row.field] ?? effectiveEnvironment[row.field]?.value
      const selected = Math.max(
        0,
        row.selectOptions.findIndex((option) => !option.custom && option.value === current)
      )
      setSelecting({ field: row.field, options: row.selectOptions, selection: selected })
      setEditing(undefined)
      return
    }
    row.activate()
  }

  useEffect(() => {
    setTerminalMouseMotion(true, stdout)
    return (): void => setTerminalMouseMotion(false, stdout)
  }, [stdout])

  useEffect(() => {
    setHoveredControl(undefined)
    pressedElement.current = undefined
  }, [step, flow, quickstartProvider, selecting?.field, modelViewportStart, width, height])

  useEffect(() => {
    if (isProviderSetup && !modelPanelVisible && (modelSearchFocused || selection >= quickstartModelOffset)) {
      selectWizardRow(PROVIDER_IDS.indexOf(quickstartProvider))
    }
  }, [
    isProviderSetup,
    modelPanelVisible,
    modelSearchFocused,
    selection,
    quickstartModelOffset,
    quickstartProvider,
    selectWizardRow,
  ])

  useProviderDiscoveryEffects(discovery, isProviderSetup, quickstartProvider)

  useEffect(() => {
    if (!isProviderSetup || awsDiscovery.credentialStatus === undefined || !ollamaDiscovery) {
      return
    }
    setDraft((current) => {
      const providers = [
        ...current.providers.filter((provider) => !config.needsSetup() || readyProviders.includes(provider)),
        ...readyProviders.filter((provider) => !current.providers.includes(provider)),
      ]
      const sameProviders =
        providers.length === current.providers.length &&
        providers.every((provider, index) => provider === current.providers[index])
      const modelProvider = providerFromModel(current.profile.model)
      const defaultProvider = providers[0]
      let profile = current.profile
      if (config.needsSetup() && defaultProvider && (!modelProvider || !providers.includes(modelProvider))) {
        const defaults = quickstartDraft(defaultProvider, effectiveEnvironment).profile
        profile = compatibleProfile({
          ...profile,
          model: defaults.model,
          effort: defaults.effort,
          caching: defaults.caching,
        })
      }
      if (sameProviders && profile === current.profile) {
        return current
      }
      return { ...current, providers, profile }
    })
  }, [awsDiscovery.credentialStatus, config, effectiveEnvironment, isProviderSetup, ollamaDiscovery, readyProviders])

  const frogElapsedMs = useBrandAnimation(frogAnimationId)

  useInput((input, key) => {
    if (agentHandoff || appearanceOpen || panelTransition.transitioning) return
    const mouse = parseMouseInput(input)
    if (mouse) {
      const scroll = mouseScrollDirection(mouse)
      if (scroll !== undefined) {
        setHoveredControl(undefined)
        if (isProviderSetup && modelListElement.current && elementContainsMouse(modelListElement.current, mouse)) {
          setModelViewportStart((start) =>
            scrollPanelViewport(start, scroll, filteredProviderModels.length, quickstartModelCapacity)
          )
        } else if (isCapabilities || isAppearance || flow === 'manual') {
          setFocusedAction(undefined)
          setSelection((current) => scrollPanelViewport(current, scroll, rows.length, 1))
        }
        return
      }
      const selectOption = elementAtMouse(selectOptionElements.current, mouse)
      const choice = elementAtMouse(choiceElements.current, mouse)
      const pathCompletion = elementAtMouse(pathCompletionElements.current, mouse)
      const directory = elementAtMouse(directoryElements.current, mouse)
      const row = elementAtMouse(rowElements.current, mouse)
      const back = backElement.current ? elementContainsMouse(backElement.current, mouse) : false
      const next = nextElement.current ? elementContainsMouse(nextElement.current, mouse) : false
      const settings = settingsElement.current ? elementContainsMouse(settingsElement.current, mouse) : false
      const frog = frogElement.current ? elementContainsMouse(frogElement.current, mouse) : false
      const search = modelSearchElement.current ? elementContainsMouse(modelSearchElement.current, mouse) : false
      const modelsPrevious =
        previousModelCount > 0 && modelPreviousElement.current
          ? elementContainsMouse(modelPreviousElement.current, mouse)
          : false
      const modelsNext =
        nextModelCount > 0 && modelNextElement.current ? elementContainsMouse(modelNextElement.current, mouse) : false
      const effortSliderHit = setupEffortSliderElement.current
        ? elementContainsMouse(setupEffortSliderElement.current, mouse)
        : false
      const target: SetupControl | undefined =
        modelsPrevious || modelsNext
          ? modelsPrevious
            ? 'models-previous'
            : 'models-next'
          : ((pathCompletion !== undefined ? `completion:${pathCompletion}` : undefined) ??
            (directory !== undefined ? `browse:${directory}` : undefined) ??
            choice ??
            (selectOption !== undefined
              ? `option:${selectOption}`
              : row !== undefined && !rows[row]?.disabled && !(isImport && row === 1 && choosingDirectory)
                ? row
                : back
                  ? 'back'
                  : next && canContinue
                    ? 'next'
                    : settings
                      ? 'settings'
                      : search
                        ? 'search'
                        : undefined))
      if (saving || choosingDirectory) {
        return
      }
      if (mouse.action === 'press' && (mouse.button & 3) === 0) {
        if (
          editing &&
          !(typeof target === 'string' && target.startsWith('completion:')) &&
          (target === undefined || typeof target !== 'number' || rows[target]?.field !== editing.field)
        ) {
          leaveEdit()
        }
        if (selecting && selectOption === undefined) {
          setSelecting(undefined)
        }
        if (effortSliderHit && reasoningSlider && reasoningRow?.choices) {
          pressedElement.current = undefined
          const option = sliderOptionAtMouse(reasoningSlider, setupEffortSliderElement.current!, mouse)
          const choice = option ? reasoningRow.choices[Number(option.id)] : undefined
          if (choice) {
            choice.activate()
            setSelection(reasoningRowIndex)
            setFocusedAction(undefined)
          }
          return
        }
        frogPress.current = frog ? { column: mouse.column, row: mouse.row } : undefined
        pressedElement.current = target
        if (selectOption !== undefined && selecting) {
          setSelecting({ ...selecting, selection: selectOption })
        } else if (pathCompletion !== undefined) {
          setPathCompletionIndex(pathCompletion)
        } else if (typeof target === 'number') {
          selectWizardRow(target)
        } else if (typeof target === 'string' && target.startsWith('browse:')) {
          selectWizardRow(directory!)
          setFocusedAction(`browse:${directory!}`)
        } else if (target === 'back' || target === 'next' || target === 'settings') {
          setFocusedAction(target)
          setModelSearchFocused(false)
        } else if (target === 'search') {
          setModelSearchFocused(true)
          setFocusedAction(undefined)
          setEditing(undefined)
        } else if (target === 'models-previous' || target === 'models-next') {
          pressedElement.current = undefined
          paginateModels(target === 'models-previous' ? -1 : 1)
          return
        } else if (choice?.startsWith('choice:')) {
          selectWizardRow(Number(choice.split(':')[1]))
        }
      } else if (mouse.action === 'release') {
        const frogClicked = frog && frogPress.current?.column === mouse.column && frogPress.current?.row === mouse.row
        frogPress.current = undefined
        const pressed = pressedElement.current
        pressedElement.current = undefined
        if (frogClicked && appearance.animations) {
          setFrogAnimationId((current) => (current ?? 0) + 1)
        } else if (directory !== undefined && pressed === `browse:${directory}` && directoryRows.has(directory)) {
          browseForDirectory(directoryRows.get(directory)!)
        } else if (typeof pressed === 'string' && pressed.startsWith('choice:') && pressed === choice) {
          const [, rowIndex, choiceIndex] = pressed.split(':')
          rows[Number(rowIndex)]?.choices?.[Number(choiceIndex)]?.activate()
        } else if (typeof pressed === 'string' && pressed.startsWith('category:') && pressed === choice) {
          setSettingsCategory(pressed.slice('category:'.length) as SettingsCategory)
          setSelection(0)
          setFocusedAction(undefined)
        } else if (typeof pressed === 'string' && pressed.startsWith('option:')) {
          const optionIndex = Number(pressed.slice('option:'.length))
          const option = selecting?.options[optionIndex]
          if (selectOption === optionIndex && option) {
            chooseSelectOption(option)
          }
        } else if (typeof pressed === 'string' && pressed.startsWith('completion:')) {
          const completionIndex = Number(pressed.slice('completion:'.length))
          if (pathCompletion === completionIndex) {
            applyPathCompletion(completionIndex)
          }
        } else if (
          typeof pressed === 'number' &&
          pressed === row &&
          (!isAppearance || !rows[pressed]?.choices?.length)
        ) {
          activateRow(pressed)
        } else if (pressed === 'back' && back) {
          moveBack()
        } else if (pressed === 'next' && next) {
          continueFlow()
        } else if (pressed === 'settings' && settings) {
          if (isSettings) moveBack()
          else openSettings()
        } else if (pressed === 'models-previous' && modelsPrevious) {
          paginateModels(-1)
        } else if (pressed === 'models-next' && modelsNext) {
          paginateModels(1)
        }
      } else if (mouse.action === 'move') {
        setHoveredControl(isCapabilities && row !== undefined ? row : target)
      }
      return
    }

    if (key.ctrl && input === 'c') {
      onCancel?.(130)
      return
    }
    if (key.ctrl && input === 's' && !appearanceOnly) {
      if (isSettings) moveBack()
      else openSettings()
      return
    }
    setHoveredControl(undefined)
    if (saving || choosingDirectory) {
      return
    }
    if (selecting) {
      if (key.escape) {
        setSelecting(undefined)
      } else if (key.tab && selecting.options.length > 0) {
        setSelecting({
          ...selecting,
          selection: (selecting.selection + (key.shift ? -1 : 1) + selecting.options.length) % selecting.options.length,
        })
      } else if (key.upArrow || key.leftArrow) {
        setSelecting({
          ...selecting,
          selection: Math.max(0, selecting.selection - 1),
        })
      } else if (key.downArrow || key.rightArrow) {
        setSelecting({
          ...selecting,
          selection: Math.min(selecting.options.length - 1, selecting.selection + 1),
        })
      } else if (key.return) {
        const option = selecting.options[selecting.selection]
        if (option) {
          chooseSelectOption(option)
        }
      }
      return
    }
    if (editing) {
      if (key.escape) {
        setEditing(undefined)
        setError(undefined)
        return
      }
      if (editing.field === 'importPath' && importCompletionCapacity > 0) {
        if (key.upArrow) {
          setPathCompletionIndex((current) =>
            current < 0
              ? importCompletionCapacity - 1
              : (current - 1 + importCompletionCapacity) % importCompletionCapacity
          )
          return
        }
        if (key.downArrow) {
          setPathCompletionIndex((current) => (current + 1) % importCompletionCapacity)
          return
        }
        if (key.tab || (key.return && pathCompletionIndex >= 0)) {
          applyPathCompletion()
          return
        }
      }
      if (key.tab) {
        leaveEdit()
      } else if (key.return) {
        commitEdit()
        return
      } else {
        const multiline = editing.field === 'instructions'
        const result = reduceInputSequence(
          { ...emptyEditor(), input: editing.value, cursor: editing.cursor ?? graphemes(editing.value).length },
          multiline ? input : input.replace(/[\r\n]/g, ''),
          key,
          'idle'
        )
        setEditing({ ...editing, value: result.state.input, cursor: result.state.cursor })
        setError(undefined)
        return
      }
    }
    if (modelPanelVisible) {
      if (key.escape && (modelQuery || modelSearchFocused)) {
        if (modelQuery) {
          updateModelQuery('')
        } else {
          selectWizardRow(PROVIDER_IDS.indexOf(quickstartProvider))
        }
        return
      }
      if (modelSearchFocused && (key.downArrow || key.return)) {
        if (filteredProviderModels.length > 0) {
          selectWizardRow(quickstartModelOffset)
        }
        return
      }
      if (modelSearchFocused && (key.leftArrow || key.rightArrow || key.upArrow)) {
        return
      }
      if (!focusedAction && key.upArrow && selection === quickstartModelOffset) {
        setModelSearchFocused(true)
        return
      }
      if (key.backspace || key.delete) {
        updateModelQuery([...modelQuery].slice(0, -1).join(''))
        return
      }
      if (key.ctrl && input === 'u') {
        updateModelQuery('')
        return
      }
      if (
        !key.ctrl &&
        !key.meta &&
        input &&
        !input.startsWith('\u001b') &&
        [...input].every((character) => (character.codePointAt(0) ?? 0) >= 0x20) &&
        (input !== ' ' || modelSearchFocused)
      ) {
        updateModelQuery(
          input === '/' && !modelSearchFocused
            ? modelQuery
            : modelQuery + sanitizeTerminalText(input).replaceAll('\n', '')
        )
        return
      }
    }
    const rowCount = isProviderSetup ? quickstartSelectableRows : rows.length
    const focusableRows = Array.from({ length: rowCount }, (_, index) => index).filter(
      (index) => !rows[index]?.disabled && index !== hiddenReasoningRowIndex
    )
    const moveRow = (direction: -1 | 1, start = 0, end = rowCount - 1): void => {
      const candidates = focusableRows.filter((index) => index >= start && index <= end)
      const target =
        direction === 1
          ? candidates.find((index) => index > selection)
          : candidates.reverse().find((index) => index < selection)
      if (target !== undefined) {
        selectWizardRow(target)
      }
    }
    if (key.escape) {
      moveBack()
    } else if (key.tab) {
      if (isSettings) {
        const categoryIndex = SETTINGS_CATEGORIES.findIndex(({ id }) => id === settingsCategory)
        const nextCategory =
          SETTINGS_CATEGORIES[
            (categoryIndex + (key.shift ? -1 : 1) + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length
          ]!
        setSettingsCategory(nextCategory.id)
        setSelection(0)
        setFocusedAction(undefined)
        return
      }
      if (step === 0) {
        if (focusedAction === 'settings') {
          setOpeningSelectionVisible(true)
        }
        setFocusedAction(focusedAction === 'settings' ? undefined : 'settings')
        setModelSearchFocused(false)
        return
      }
      const controls: (number | SetupAction | 'search')[] = [
        ...focusableRows
          .filter((index) => !modelPanelVisible || index < quickstartModelOffset)
          .flatMap((index) => (directoryRows.has(index) ? [index, `browse:${index}` as const] : [index])),
        ...(modelPanelVisible
          ? (['search', ...focusableRows.filter((index) => index >= quickstartModelOffset)] as const)
          : []),
        ...(step > 0 && hasExternalActions ? (['back', ...(canContinue ? ['next' as const] : [])] as const) : []),
      ]
      const index = controls.indexOf(modelSearchFocused ? 'search' : (focusedAction ?? selection))
      const target = controls[(index + (key.shift ? -1 : 1) + controls.length) % controls.length]
      if (typeof target === 'number') {
        selectWizardRow(target)
        if (rows[target]?.field && rows[target]?.input !== false && !rows[target]?.selectOptions) {
          rows[target]!.activate()
        }
      } else if (target === 'search') {
        setModelSearchFocused(true)
        setFocusedAction(undefined)
      } else {
        setFocusedAction(target)
        setModelSearchFocused(false)
        if (target?.startsWith('browse:')) {
          setSelection(Number(target.slice('browse:'.length)))
        }
      }
    } else if (focusedAction) {
      if (focusedAction === 'settings') {
        if (key.return || input === ' ') {
          if (isSettings) moveBack()
          else openSettings()
        } else if (key.upArrow && step !== 0) {
          setFocusedAction(undefined)
        }
      } else if (focusedAction.startsWith('browse:')) {
        const index = Number(focusedAction.slice('browse:'.length))
        if (key.return || input === ' ') {
          browseForDirectory(directoryRows.get(index)!)
        } else if (key.leftArrow || key.upArrow) {
          selectWizardRow(index)
        }
      } else if (key.leftArrow) {
        setFocusedAction('back')
      } else if (key.rightArrow) {
        if (canContinue) setFocusedAction('next')
      } else if (key.upArrow) {
        setFocusedAction(undefined)
      } else if (key.return || input === ' ') {
        if (focusedAction === 'back') moveBack()
        else continueFlow()
      }
    } else if ((key.leftArrow || key.rightArrow) && rows[selection]?.choices?.length) {
      const choices = rows[selection]!.choices!
      const selected = choices.findIndex((choice) => choice.active)
      const next =
        selected < 0
          ? key.leftArrow
            ? 0
            : choices.length - 1
          : (selected + (key.leftArrow ? -1 : 1) + choices.length) % choices.length
      choices[next]!.activate()
    } else if (splitQuickstart && (key.upArrow || key.leftArrow)) {
      const columnStart =
        selection < PROVIDER_IDS.length
          ? 0
          : selection < quickstartModelOffset
            ? PROVIDER_IDS.length
            : quickstartModelOffset
      moveRow(-1, columnStart)
    } else if (splitQuickstart && (key.downArrow || key.rightArrow)) {
      const columnEnd =
        selection < PROVIDER_IDS.length
          ? PROVIDER_IDS.length - 1
          : selection < quickstartModelOffset
            ? quickstartModelOffset - 1
            : quickstartSelectableRows - 1
      moveRow(1, 0, columnEnd)
    } else if (
      step === 0 &&
      openingColumns === 2 &&
      (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
    ) {
      setOpeningSelectionVisible(true)
      const column = selection % openingColumns
      const next = key.leftArrow
        ? column > 0
          ? selection - 1
          : selection
        : key.rightArrow
          ? column < openingColumns - 1
            ? selection + 1
            : selection
          : key.upArrow
            ? Math.max(0, selection - openingColumns)
            : Math.min(OPENING_CHOICES.length - 1, selection + openingColumns)
      selectWizardRow(next)
    } else if (key.upArrow || key.leftArrow) {
      if (step === 0) setOpeningSelectionVisible(true)
      moveRow(-1)
    } else if (key.downArrow || key.rightArrow) {
      if (step === 0) setOpeningSelectionVisible(true)
      moveRow(1)
    } else if (key.return || input === ' ') {
      activateRow(selection)
    } else if (
      rows[selection]?.field &&
      rows[selection]?.input !== false &&
      !rows[selection]?.disabled &&
      !rows[selection]?.selectOptions &&
      input &&
      !key.ctrl &&
      !key.meta
    ) {
      rows[selection]!.activate()
      setEditing((current) => {
        if (!current) return current
        const result = reduceInputSequence(
          { ...emptyEditor(), input: current.value, cursor: graphemes(current.value).length },
          input,
          key,
          'idle'
        )
        return { ...current, value: result.state.input, cursor: result.state.cursor }
      })
    }
  })

  const isSetupCompletion =
    isAppearance ||
    (flow === 'quickstart' && step === 3) ||
    (flow === 'manual' && step === MANUAL_STEPS.length) ||
    (flow === 'import' && step === 1)
  const primaryLabel = saving
    ? 'Saving...'
    : isSetupCompletion
      ? deferred || !config.needsSetup()
        ? 'Save and Launch'
        : 'Launch Strands harness'
      : flow === 'agent'
        ? 'Start Q&A'
        : 'Continue'
  const escapeAction = editing || selecting ? 'cancel' : step === 0 ? 'exit' : 'back'
  const navigationHints = editing
    ? [
        width < 32 ? 'Enter save · Tab move' : 'Enter save · Tab/Shift+Tab move',
        editing.field === 'instructions'
          ? 'Ctrl+J newline · Esc cancel'
          : width < 60
            ? 'Click focus · Esc cancel'
            : 'Mouse click: switch controls · Ctrl+U: clear · Esc: cancel',
      ]
    : [
        width < 32
          ? 'Click/Enter · ↑↓'
          : width < 60
            ? 'Click/Enter choose · ↑↓ move'
            : 'Click or Enter to choose · Arrow keys (↑↓) to move',
        width < 32
          ? 'Shift+Tab'
          : width < 60
            ? `Tab/Shift+Tab focus · Esc ${escapeAction}`
            : step === 0
              ? 'Tab / Shift+Tab: grid ↔ Settings · Esc to exit'
              : `Tab / Shift+Tab to move focus · Esc to ${escapeAction}`,
      ]

  const settingsHovered = hoveredControl === 'settings'
  const settingsBackHovered = isSettings && settingsHovered
  const settingsButton = !appearanceOnly ? (
    <Box
      ref={(element) => {
        settingsElement.current = element ?? undefined
      }}
      width={11}
      height={1}
      paddingX={1}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={
        settingsBackHovered
          ? backHoverBackground
          : (controlBackground('settings', focusedAction === 'settings') ?? COMMAND_DECK_BACKGROUND)
      }
    >
      <Text color={settingsBackHovered ? palette.muted : focusedAction === 'settings' ? accent : palette.muted}>
        {isSettings ? 'Back' : 'Settings'}
      </Text>
    </Box>
  ) : null

  if (agentHandoff) {
    const canvasHeight = Math.max(12, height - 2)
    const guideHeight = Math.max(4, height - 4)
    const { wide, frogWidth, frogHeight, contentWidth } = setupGuideLayout(lockupWidth, guideHeight)
    const landingX = wide
      ? Math.max(frogWidth / 2, Math.floor((lockupWidth - contentWidth) / 2) + frogWidth / 2)
      : lockupWidth / 2
    const landingY = Math.max(7, guideHeight + frogHeight - 16)
    return (
      <Box
        width={width}
        height={height}
        paddingX={1}
        paddingTop={2}
        overflow="hidden"
        backgroundColor={palette.background}
      >
        <Text>
          {renderSetupGuideTransitionFrame(
            lockupWidth,
            canvasHeight,
            agentHandoffElapsedMs / SETUP_GUIDE_TRANSITION_DURATION_MS,
            agentHandoffElapsedMs,
            landingX,
            true,
            appearance.frogTheme,
            {
              colorMode: palette.mode,
              customBase: appearance.customTheme.base,
              ...(appearance.frogTheme === 'custom' ? { frogColor: palette.frog } : {}),
            },
            landingY
          )}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      width={width}
      height={height}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={palette.background}
    >
      {showBrand ? (
        <SetupBrand
          frame={brandFrame}
          appearance={appearance}
          animationId={frogAnimationId}
          elapsedMs={frogElapsedMs}
          onFrogElement={(element) => {
            frogElement.current = element ?? undefined
          }}
        />
      ) : null}
      {step === 0 ? (
        <Fade background={palette.background} progress={panelTransition.progress}>
          <OpeningMenu
            width={lockupWidth}
            buttonHeight={openingButtonHeight}
            selection={selection}
            showSelection={openingSelectionVisible}
            {...(typeof hoveredControl === 'number' ? { hovered: hoveredControl } : {})}
            topGap={openingTopGap}
            animate={appearance.animations}
            {...(error ? { error } : {})}
            onRowElement={(index, element) => registerElement(rowElements.current, index, element)}
          />
        </Fade>
      ) : null}
      {step === 0 ? null : (
        <Fade background={palette.background} progress={panelTransition.progress}>
          <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" overflow="hidden">
            {progress ? (
              <Box width={bubbleWidth} marginBottom={1} alignItems="center" flexDirection="column" flexShrink={0}>
                <Text bold color={accent} wrap="truncate-end">
                  {progress.instruction}
                </Text>
                <SetupProgress
                  current={progress.current}
                  total={progress.total}
                  width={Math.min(bubbleWidth, 48)}
                  animate={appearance.animations}
                />
              </Box>
            ) : null}
            <Box
              width={bubbleWidth}
              height={bubbleHeight}
              flexDirection="column"
              overflow="hidden"
              backgroundColor={PANEL_BACKGROUND}
            >
              {!isAppearance && flow === 'manual' && !isProviderSetup && !isCapabilities ? (
                <Box paddingX={1} marginBottom={1} justifyContent="space-between" flexShrink={0}>
                  <Text bold color={accent}>
                    {isSettings ? 'Settings' : isAppearance ? 'Appearance' : MANUAL_STEPS[step - 1]}
                  </Text>
                  {manualOverflowLabel ? <Text dimColor>{manualOverflowLabel}</Text> : null}
                </Box>
              ) : null}
              {isCapabilities ? (
                <>
                  <Box paddingX={1} marginBottom={1} justifyContent="space-between" flexShrink={0}>
                    <Text bold color={accent}>
                      {isTools ? 'Tools' : 'Plugins & features'}
                    </Text>
                    <Box
                      ref={(element) => registerElement(rowElements.current, 0, element)}
                      paddingX={1}
                      backgroundColor={rowBackground(0) ?? COMMAND_DECK_BACKGROUND}
                    >
                      <Text bold>{rows[0]!.label}</Text>
                    </Box>
                  </Box>
                  {renderCapabilityRows(visibleCapabilityRows)}
                </>
              ) : isImport ? (
                <Box flexGrow={1} paddingX={2} paddingY={1} flexDirection="column" overflow="hidden">
                  <Text bold wrap="truncate-end">
                    Import an agent
                  </Text>
                  <Box marginTop={1}>
                    <Text bold {...(selection === 0 ? { color: accent } : {})} wrap="truncate-end">
                      Path to ZIP, file, or folder
                    </Text>
                  </Box>
                  <Box height={3} flexDirection="row">
                    <Box
                      ref={(element) => registerElement(rowElements.current, 0, element)}
                      flexGrow={1}
                      paddingX={1}
                      flexDirection="column"
                      justifyContent="center"
                      backgroundColor={rowBackground(0) ?? COMMAND_DECK_BACKGROUND}
                    >
                      <EditableText
                        value={editing?.field === 'importPath' ? editing.value : importPath}
                        cursor={
                          editing?.field === 'importPath'
                            ? (editing.cursor ?? graphemes(editing.value).length)
                            : graphemes(importPath).length
                        }
                        width={Math.max(1, bubbleWidth - (canChooseDirectory() ? 17 : 6))}
                        active={editing?.field === 'importPath'}
                        animate={appearance.animations}
                      />
                    </Box>
                    {canChooseDirectory() ? (
                      <Box
                        ref={(element) => registerElement(rowElements.current, 1, element)}
                        width={12}
                        marginLeft={1}
                        alignItems="center"
                        justifyContent="center"
                        backgroundColor={
                          controlBackground(1, focusedAction === undefined && selection === 1, choosingDirectory) ??
                          COMMAND_DECK_BACKGROUND
                        }
                      >
                        <Text
                          bold
                          {...(selection === 1 && !choosingDirectory ? { color: accent } : {})}
                          dimColor={choosingDirectory}
                        >
                          {choosingDirectory ? 'Opening...' : 'Browse'}
                        </Text>
                      </Box>
                    ) : null}
                  </Box>
                  {pathEditing && importCompletionCapacity > 0 ? (
                    <Box flexDirection="column" flexShrink={0}>
                      <Box paddingX={1} height={1} flexShrink={0}>
                        <Text dimColor wrap="truncate-end">
                          Suggestions · ↑↓ choose · Tab complete
                        </Text>
                      </Box>
                      {pathCompletions.slice(0, importCompletionCapacity).map((completion, index) => (
                        <Box
                          key={completion.value}
                          ref={(element) => registerElement(pathCompletionElements.current, index, element)}
                          height={1}
                          paddingX={1}
                          flexShrink={0}
                          backgroundColor={
                            pathCompletionIndex === index || hoveredControl === `completion:${index}`
                              ? PANEL_SELECTION
                              : undefined
                          }
                        >
                          <Text color={pathCompletionIndex === index ? accent : palette.foreground} wrap="truncate-end">
                            {pathCompletionIndex === index ? '› ' : '  '}
                            {sanitizeTerminalText(completion.label).replaceAll('\n', '\\n').replaceAll('\t', '\\t')}
                            <Text dimColor>{completion.directory ? '  folder' : '  file'}</Text>
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  ) : null}
                </Box>
              ) : splitQuickstart ? (
                <Box flexGrow={1} flexDirection="row" overflow="hidden">
                  <Box
                    width={quickstartProviderColumnWidth}
                    flexShrink={0}
                    paddingX={1}
                    flexDirection="column"
                    overflow="hidden"
                  >
                    <Box marginBottom={1} flexShrink={0}>
                      <Text bold color={accent}>
                        Providers
                      </Text>
                    </Box>
                    <Box height={quickstartProviderListHeight} flexShrink={0} flexDirection="column" overflow="hidden">
                      <ProviderList
                        items={providerRows.map((row) => ({
                          id: row.id,
                          label: row.label,
                          description: row.description,
                          ...(row.status ? { status: row.status } : {}),
                        }))}
                        selected={quickstartProvider}
                        width={quickstartProviderColumnWidth - 2}
                        rowHeight={quickstartProviderRowHeight}
                        selectedBackground
                        {...(typeof hoveredControl === 'number' &&
                        hoveredControl >= 0 &&
                        hoveredControl < PROVIDER_IDS.length
                          ? { hovered: PROVIDER_IDS[hoveredControl] }
                          : {})}
                        onElement={(id, element) =>
                          registerElement(rowElements.current, PROVIDER_IDS.indexOf(id as ProviderId), element)
                        }
                      />
                    </Box>
                    <Box flexGrow={1} />
                    {refreshRow ? renderRefreshButton(refreshRow, quickstartProviderColumnWidth - 2, true) : null}
                  </Box>
                  <Box
                    width={quickstartDetailColumnWidth}
                    flexGrow={1}
                    flexShrink={0}
                    paddingX={1}
                    flexDirection="column"
                    overflow="hidden"
                  >
                    {showProviderConfiguration ? (
                      <>
                        {middleFacts.length > 0 || middleWarningLines.length > 0 ? (
                          <Box paddingX={1} marginBottom={middleFieldGap} flexShrink={0} flexDirection="column">
                            {middleFacts.map((fact) => (
                              <Box key={fact.label}>
                                <Text dimColor>{fact.label}: </Text>
                                <Text bold color={palette[fact.status]}>
                                  {fact.value}
                                </Text>
                              </Box>
                            ))}
                            {middleWarningLines.length > 0 ? (
                              <Box marginTop={middleFacts.length > 0 ? 1 : 0}>
                                <Text color={palette[providerWarningStatus]}>{middleWarningLines.join('\n')}</Text>
                              </Box>
                            ) : null}
                          </Box>
                        ) : null}
                        {selecting
                          ? renderProviderSelect(selecting)
                          : visibleProviderFieldRows.map((row) =>
                              renderProviderField(row, quickstartDetailColumnWidth - 3)
                            )}
                      </>
                    ) : (
                      <Box flexGrow={1} flexDirection={showReasoningPanel ? 'row' : 'column'} overflow="hidden">
                        <Box ref={modelListElement} flexGrow={1} flexDirection="column" overflow="hidden">
                          <Box flexShrink={0}>
                            <Text bold color={accent}>
                              Models
                            </Text>
                          </Box>
                          <Box
                            ref={modelSearchElement}
                            marginBottom={1}
                            flexShrink={0}
                            backgroundColor={controlBackground('search', modelSearchFocused)}
                          >
                            <Text wrap="truncate-end">
                              {modelSearchFocused ? (
                                <>
                                  {modelQuery}
                                  <BlinkingCursor animate={appearance.animations} />
                                </>
                              ) : (
                                <Text dimColor>/ {modelQuery || 'Search models'}</Text>
                              )}
                            </Text>
                          </Box>
                          {showModelPagination ? (
                            <Box
                              ref={modelPreviousElement}
                              width="100%"
                              height={1}
                              paddingX={1}
                              flexShrink={0}
                              backgroundColor={controlBackground('models-previous', false) ?? COMMAND_DECK_BACKGROUND}
                            >
                              <Text
                                {...(previousModelCount > 0
                                  ? {
                                      color: hoveredControl === 'models-previous' ? accent : palette.muted,
                                      bold: hoveredControl === 'models-previous',
                                    }
                                  : { dimColor: true })}
                              >
                                ↑ Previous{previousModelCount > 0 ? ` · ${previousModelCount}` : ''}
                              </Text>
                            </Box>
                          ) : null}
                          <Box flexShrink={0} flexDirection="column" overflow="hidden">
                            {providerModels.provider !== quickstartProvider || providerModels.loading ? (
                              <Text dimColor>Loading model catalog...</Text>
                            ) : !providerModels.available ? (
                              <Text color={palette.warning}>
                                Model catalog unavailable
                                {providerModels.error ? ` · ${providerModels.error}` : ''}
                              </Text>
                            ) : visibleProviderModels.length === 0 ? (
                              <Text dimColor>{modelQuery.trim() ? 'No matching models' : 'No models reported'}</Text>
                            ) : (
                              <>
                                {visibleProviderModels.map((model, visibleIndex) => {
                                  const modelIndex = quickstartModelViewportStart + visibleIndex
                                  const index = quickstartModelOffset + modelIndex
                                  const active =
                                    `${quickstartProvider}/${model.id}` === draft.profile.model &&
                                    deselectedModel !== draft.profile.model
                                  const focused =
                                    focusedAction === undefined && !modelSearchFocused && index === selection
                                  const hovered = hoveredControl === index
                                  const highlighted = focused || hovered
                                  const harnessDefault = model.id === quickstartDefaultModel
                                  const modelSpecifier = `${quickstartProvider}/${model.id}`
                                  return (
                                    <Box
                                      key={model.id}
                                      ref={(element) => registerElement(rowElements.current, index, element)}
                                      width="100%"
                                      height={quickstartModelRowHeight}
                                      paddingX={1}
                                      flexShrink={0}
                                      overflow="hidden"
                                      backgroundColor={
                                        rowBackground(index) ?? (active ? COMMAND_DECK_BACKGROUND : undefined)
                                      }
                                    >
                                      <Box width={2} flexShrink={0}>
                                        <Text {...(active || highlighted ? { color: accent, bold: true } : {})}>
                                          {active ? '✓ ' : highlighted ? '› ' : '  '}
                                        </Text>
                                      </Box>
                                      <Box
                                        {...(showReasoningPanel
                                          ? { flexGrow: 1 }
                                          : { width: quickstartModelNameWidth, flexShrink: 0 })}
                                        overflow="hidden"
                                      >
                                        <Text
                                          {...(active || highlighted ? { color: accent, bold: true } : {})}
                                          wrap="truncate-end"
                                        >
                                          {model.name}
                                          {harnessDefault ? <Text color={accent}> ★</Text> : null}
                                        </Text>
                                      </Box>
                                      {!showReasoningPanel ? (
                                        <>
                                          <Box width={1} flexShrink={0} />
                                          <Box width={quickstartModelIdWidth} flexShrink={0} overflow="hidden">
                                            <Text dimColor wrap="truncate-end">
                                              {modelSpecifier}
                                            </Text>
                                          </Box>
                                        </>
                                      ) : null}
                                    </Box>
                                  )
                                })}
                              </>
                            )}
                          </Box>
                          {showModelPagination ? (
                            <Box
                              ref={modelNextElement}
                              width="100%"
                              height={1}
                              paddingX={1}
                              flexShrink={0}
                              backgroundColor={controlBackground('models-next', false) ?? COMMAND_DECK_BACKGROUND}
                            >
                              <Text
                                {...(nextModelCount > 0
                                  ? {
                                      color: hoveredControl === 'models-next' ? accent : palette.muted,
                                      bold: hoveredControl === 'models-next',
                                    }
                                  : { dimColor: true })}
                              >
                                ↓ Next{nextModelCount > 0 ? ` · ${nextModelCount} more` : ''}
                              </Text>
                            </Box>
                          ) : null}
                          {readyProviderControlRows.length > 0 ? (
                            <Box flexShrink={0} flexDirection="column">
                              {readyProviderControlRows.map((row) =>
                                renderProviderField(row, quickstartDetailColumnWidth - (showReasoningPanel ? 36 : 3))
                              )}
                            </Box>
                          ) : null}
                        </Box>
                        {showReasoningPanel ? (
                          <Box width={32} marginLeft={1} paddingLeft={1} flexDirection="column" flexShrink={0}>
                            <Text bold color={accent}>
                              Reasoning
                            </Text>
                            <EffortSlider
                              slider={reasoningSlider}
                              width={26}
                              compact={false}
                              pressed={false}
                              focused={reasoningRowIndex === selection}
                              onElement={(element) => {
                                setupEffortSliderElement.current = element
                                registerElement(rowElements.current, reasoningRowIndex, element)
                              }}
                            />
                          </Box>
                        ) : null}
                      </Box>
                    )}
                  </Box>
                </Box>
              ) : isAppearance ? (
                <SetupSettingsPanel
                  rows={visibleRows}
                  category={settingsCategory}
                  settings={{ ...panelSettings, ...draft.settings, ...appearance }}
                  start={viewportStart}
                  selected={selection}
                  width={bubbleWidth}
                  height={bubbleHeight}
                  {...(typeof hoveredControl === 'string' ? { hoveredControl } : {})}
                  onRowElement={(index, element) => registerElement(rowElements.current, index, element)}
                  onChoiceElement={(target, element) => registerElement(choiceElements.current, target, element)}
                />
              ) : isPermissions ? (
                <Box flexGrow={1} paddingX={1} flexDirection="column" overflow="hidden">
                  <Box height={7} flexShrink={0}>
                    {rows.slice(0, 3).map((row, index) => (
                      <Box
                        key={row.id}
                        ref={(element) => registerElement(rowElements.current, index, element)}
                        flexGrow={1}
                        flexBasis={0}
                        height={7}
                        marginRight={index < 2 ? 1 : 0}
                        paddingX={1}
                        borderStyle="single"
                        borderColor={index === selection ? accent : row.active ? palette.success : palette.muted}
                        flexDirection="column"
                        justifyContent="center"
                        backgroundColor={rowBackground(index)}
                      >
                        <Text bold color={row.active || index === selection ? accent : palette.foreground}>
                          {row.active ? '◆ ' : ''}
                          {row.label}
                        </Text>
                        <Text dimColor wrap="wrap">
                          {row.description}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                  {draft.customPermissions ? (
                    <Box marginTop={1} flexGrow={1} flexDirection="column" overflow="hidden">
                      <Box justifyContent="space-between" flexShrink={0}>
                        <Text bold>Per-tool behavior</Text>
                        <Text dimColor>
                          {permissionViewportStart > 3 ? `↑ ${permissionViewportStart - 3}  ` : ''}
                          {permissionViewportStart + visiblePermissionTools.length < rows.length
                            ? `↓ ${rows.length - permissionViewportStart - visiblePermissionTools.length}`
                            : ''}
                        </Text>
                      </Box>
                      {visiblePermissionTools.map((row, visibleIndex) => {
                        const index = permissionViewportStart + visibleIndex
                        return (
                          <Box
                            key={row.id}
                            ref={(element) => registerElement(rowElements.current, index, element)}
                            height={rowHeight}
                            paddingX={1}
                            flexShrink={0}
                            flexDirection="column"
                            backgroundColor={rowBackground(index)}
                          >
                            <Text
                              bold={row.active === true}
                              color={row.active || index === selection ? accent : palette.foreground}
                            >
                              {row.active ? '☑ ' : '☐ '}
                              {row.label}
                            </Text>
                            <Text dimColor wrap="truncate-end">
                              {row.description}
                            </Text>
                          </Box>
                        )
                      })}
                    </Box>
                  ) : (
                    <Box marginTop={1} paddingX={1}>
                      <Text dimColor>
                        Choose Custom to set per-tool overrides. Unselected tools continue to use the default policy.
                      </Text>
                    </Box>
                  )}
                </Box>
              ) : selecting ? (
                renderProviderSelect(selecting)
              ) : (
                <Box flexGrow={1} flexDirection="column" overflow="hidden">
                  {visibleRows.map((row, visibleIndex) => {
                    const index = viewportStart + visibleIndex
                    if (row.id === 'refresh-provider') {
                      return renderRefreshButton(row, bubbleWidth - 2)
                    }
                    if (isProviderSetup && row.status) {
                      return (
                        <ProviderList
                          key={row.id}
                          items={[
                            {
                              id: row.id,
                              label: row.label,
                              description: row.description,
                              status: row.status,
                            },
                          ]}
                          selected={quickstartProvider}
                          width={bubbleWidth}
                          rowHeight={rowHeight}
                          selectedBackground
                          {...(hoveredControl === index ? { hovered: row.id } : {})}
                          onElement={(_, element) => registerElement(rowElements.current, index, element)}
                        />
                      )
                    }
                    const activeEditing = editing?.field === row.field ? editing : undefined
                    return (
                      <Box
                        key={row.id}
                        ref={(element) => registerElement(rowElements.current, index, element)}
                        paddingX={row.field ? 0 : 1}
                        height={rowHeight}
                        flexShrink={0}
                        flexDirection="column"
                        backgroundColor={row.field ? undefined : rowBackground(index)}
                      >
                        <Box paddingX={row.field ? 1 : 0} justifyContent="space-between" flexShrink={0}>
                          <Text
                            bold={row.field !== undefined}
                            {...(!row.disabled && index === selection ? { color: accent } : {})}
                            dimColor={row.disabled === true}
                            wrap="truncate-end"
                          >
                            {row.status ? (
                              <Text color={palette[row.status]}>● </Text>
                            ) : row.field ? (
                              ''
                            ) : row.active === undefined ? (
                              ''
                            ) : row.active ? (
                              '☑ '
                            ) : (
                              '☐ '
                            )}
                            {row.label}
                            {flow === 'manual' && step === MANUAL_STEPS.length ? '  →' : ''}
                          </Text>
                          {directoryRows.has(index) ? (
                            <Box
                              ref={(element) => registerElement(directoryElements.current, index, element)}
                              paddingX={1}
                              flexShrink={0}
                              backgroundColor={
                                controlBackground(`browse:${index}`, focusedAction === `browse:${index}`) ??
                                COMMAND_DECK_BACKGROUND
                              }
                            >
                              <Text bold>
                                {choosingDirectory && focusedAction === `browse:${index}` ? 'Opening...' : 'Browse'}
                              </Text>
                            </Box>
                          ) : null}
                        </Box>
                        {row.choices?.length ? (
                          renderChoices(row.choices, index)
                        ) : row.field ? (
                          <Box
                            flexGrow={1}
                            paddingX={1}
                            flexDirection="column"
                            justifyContent={row.field === 'instructions' ? 'flex-start' : 'center'}
                            backgroundColor={rowBackground(index) ?? COMMAND_DECK_BACKGROUND}
                          >
                            <EditableText
                              value={activeEditing?.value ?? row.description}
                              cursor={
                                activeEditing
                                  ? (activeEditing.cursor ?? graphemes(activeEditing.value).length)
                                  : graphemes(row.description).length
                              }
                              width={Math.max(1, bubbleWidth - 4)}
                              maxRows={row.field === 'instructions' ? rowHeight - 2 : 1}
                              active={Boolean(activeEditing)}
                              animate={appearance.animations}
                            />
                          </Box>
                        ) : (
                          <Text
                            {...(row.descriptionColor
                              ? { color: row.descriptionColor }
                              : row.status
                                ? { color: palette[row.status] }
                                : { dimColor: true })}
                            wrap="truncate-end"
                          >
                            {row.description}
                          </Text>
                        )}
                      </Box>
                    )
                  })}
                </Box>
              )}
              {warningHeight > 0 ? (
                <Box paddingX={1} marginTop={warningGap} height={warningHeight} flexShrink={0}>
                  <Text color={palette[providerWarningStatus]}>{warningLines.join('\n')}</Text>
                </Box>
              ) : null}
              {error ? (
                <Box paddingX={1} height={1}>
                  <Text color="red" wrap="truncate-end">
                    {error}
                  </Text>
                </Box>
              ) : null}
            </Box>
            {hasExternalActions ? (
              <Box
                width={bubbleWidth}
                height={actionHeight}
                marginTop={actionGap}
                columnGap={actionColumnGap}
                justifyContent="space-between"
              >
                {(
                  [
                    ['back', 'Back', backElement],
                    ['next', primaryLabel, nextElement],
                  ] as const
                ).map(([action, label, elementRef]): ReactElement => {
                  const primary = action === 'next'
                  const enabled = canContinue && !saving
                  const active = focusedAction === action
                  const hovered = hoveredControl === action
                  const interactiveHover = hovered && (!primary || enabled)
                  return (
                    <Box
                      key={action}
                      ref={(element) => {
                        elementRef.current = element ?? undefined
                      }}
                      width={actionWidth}
                      height={actionHeight}
                      alignItems="center"
                      justifyContent="center"
                      backgroundColor={
                        interactiveHover
                          ? action === 'back'
                            ? backHoverBackground
                            : nextHoverBackground
                          : active
                            ? PANEL_SELECTION
                            : (controlBackground(action, active, primary && !canContinue) ?? COMMAND_DECK_BACKGROUND)
                      }
                    >
                      <Text
                        bold
                        {...(interactiveHover ? { color: palette.foreground } : active ? { color: accent } : {})}
                        dimColor={primary ? !enabled : saving}
                      >
                        {label}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            ) : null}
          </Box>
        </Fade>
      )}
      {width < 32 ? (
        <Box height={navigationHeight} flexShrink={0} flexDirection="column">
          <Box justifyContent="center">
            <Text dimColor wrap="truncate-end">
              {navigationHints[0]}
            </Text>
          </Box>
          <Box height={1} alignItems="center">
            {settingsButton}
            <Box flexGrow={1} justifyContent="center" overflow="hidden">
              <Text dimColor wrap="truncate-end">
                {navigationHints[1]}
              </Text>
            </Box>
          </Box>
        </Box>
      ) : (
        <Box height={navigationHeight} flexShrink={0} alignItems="center">
          {settingsButton}
          <Box flexGrow={1} flexDirection="column" alignItems="center" overflow="hidden">
            {navigationHints.map((hint) => (
              <Text key={hint} dimColor wrap="truncate-end">
                {hint}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {appearanceOpen ? (
        <CustomThemeEditor
          settings={priorAppearance.current}
          animate={appearance.animations}
          width={width}
          height={height}
          onPreview={previewAppearance}
          onClose={closeAppearance}
          onApply={(next) => {
            priorAppearance.current = { ...appearance, ...next }
            updateAppearance(priorAppearance.current)
          }}
        />
      ) : null}
    </Box>
  )
}

function isProviderEnvironmentKey(value: EditableField): value is ProviderEnvironmentKey {
  return PROVIDER_ENVIRONMENT_KEYS.includes(value as ProviderEnvironmentKey)
}
