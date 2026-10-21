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
import { Box, useInput, useStdout, type DOMElement } from 'ink'
import { useTerminalSize } from '../../terminal/size.js'
import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'
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
import { configurationFromStore, type SetupChange } from '../../agent-configuration.js'
import type { ChatSettings } from '../../chat/types.js'
import type { SettingsCategory } from '../../settings.js'
import { DEFAULT_SETTINGS_CATEGORY, SETTINGS_CATEGORIES } from '../../settings.js'
import { parseMouseInput, type MouseInput } from '../../terminal/mouse-input.js'
import { emptyEditor, graphemes, reduceInputSequence } from '../../terminal/composer.js'
import { errorMessage, sanitizeTerminalText } from '../../terminal/sanitize.js'
import { canUseNativePicker, chooseAgentProject, chooseDirectory } from '../../terminal/directory-picker.js'
import { setTerminalMouseMotion } from '../../terminal/terminal.js'
import {
  elementAtMouse,
  elementContainsMouse,
  registerElement,
  mouseScrollDirection,
  scrollPanelViewport,
  revealPanelSelection,
  sliderOptionAtMouse,
  type SettingsPanelFocus,
} from '../interaction.js'
import { wrapLines } from '../presentation.js'
import { Text, ThemeProvider, useTheme } from '../theme.js'
import { Cursor, EditableText } from '../text-input.js'
import { Fade, useFadeTransition } from '../fade-in.js'

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
  CUSTOMIZE_STEPS,
  OPENING_CHOICES,
  rowsForStep,
  setupStepProgress,
  wizardSettingsRows,
} from './steps.js'
import { useBrandAnimation, useBrandAnimationFrame } from '../startup-view.js'
import { SetupBrand, setupBrandFrame } from './brand.js'
import { OpeningMenu, openingGridLayout, openingNeighbor } from './opening-menu.js'
import { SetupSettingsPanel, type SetupSettingsChoiceTarget } from './settings-panel.js'
import { EffortSlider } from '../model-panel.js'
import { ProviderList } from '../provider-list.js'
import { PanelSection } from '../panel-sections.js'
import { useProviderDiscovery, useProviderDiscoveryEffects } from './use-provider-discovery.js'
import type { AppearanceSettings, EditableField, SelectOption, SetupDraft, SetupFlow, WizardRow } from './types.js'
import { importPathCompletions } from './path-completion.js'
import { SetupProgress } from './progress.js'
import { SetupToggle } from './toggle.js'
import { availableCliUpdate } from '../../update-check.js'

type SetupAction = 'back' | 'next' | 'escape' | 'settings' | `browse:${number}`
type ProviderSetupSection = 'providers' | 'models' | 'options' | 'actions'
type SetupSection =
  'form' | 'bulk' | 'items' | 'modes' | 'tools' | 'list' | 'import' | 'categories' | 'settings' | 'actions'

function setupRowSection(flow: SetupFlow | undefined, step: number, row: WizardRow | undefined): SetupSection {
  if (step === APPEARANCE_STEP) return 'settings'
  if (flow === 'import') return 'import'
  if (step === 2 || step === 5) return 'form'
  if (step === 3 || step === 4) return row?.id === 'select-all' ? 'bulk' : 'items'
  if (step === 6) return row?.id.startsWith('permission-tool:') ? 'tools' : 'modes'
  return 'list'
}

function dataRowHeight(row: WizardRow, stacked: boolean): number {
  return row.active !== undefined ? 1 : stacked ? 4 : 3
}

function setupRowViewport(
  heights: readonly number[],
  selected: number,
  availableHeight: number,
  previousStart: number
): { start: number; end: number } {
  let start = Math.min(previousStart, selected)
  let end = start
  let used = 0
  while (end < heights.length && used + heights[end]! <= availableHeight) used += heights[end++]!
  while (end === heights.length && start > 0 && used + heights[start - 1]! <= availableHeight) {
    used += heights[--start]!
  }
  if (selected < end) return { start, end }
  start = selected
  end = selected + 1
  used = heights[selected] ?? 0
  while (start > 0 && used + heights[start - 1]! <= availableHeight) used += heights[--start]!
  while (end < heights.length && used + heights[end]! <= availableHeight) used += heights[end++]!
  return { start, end }
}

const SHORT_PROVIDER_LABELS: Record<ProviderId, string> = {
  ...PROVIDER_LABELS,
  bedrock: 'Bedrock',
  'bedrock-mantle': 'Mantle',
  google: 'Gemini',
}
type SetupControl =
  | number
  | SetupAction
  | 'search'
  | 'models-previous'
  | 'models-next'
  | 'section:models'
  | 'section:options'
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
  onExit,
  escapeHint = 'Esc to exit',
  introStartedAt,
  initialSettings,
  checkForUpdate = availableCliUpdate,
}: {
  appearance: AppearanceSettings
  setAppearance: Dispatch<SetStateAction<AppearanceSettings>>
  config: CliConfigStore
  deferred?: boolean
  appearanceOnly?: boolean
  onComplete(change?: SetupChange): void
  onCancel?(exitCode: 0 | 130): void
  /** Leaves setup and the CLI from the opening menu when there is no harness to return to. */
  onExit?(): void
  /** Names where Esc leads from the opening menu. */
  escapeHint?: string
  /** When set, the brand plays the launch spiral intro from this timestamp. */
  introStartedAt?: number
  initialSettings?: Partial<ChatSettings>
  /** Resolves a newer published CLI version to announce on the opening menu. */
  checkForUpdate?(): Promise<string | undefined>
}): ReactElement {
  const { stdout } = useStdout()
  const { columns, rows: terminalRows } = useTerminalSize()
  const [flow, setFlow] = useState<SetupFlow>()
  const [step, setStep] = useState(appearanceOnly ? APPEARANCE_STEP : 0)
  const [settingsReturn, setSettingsReturn] = useState<{
    flow: SetupFlow | undefined
    step: number
    selection: number
  }>()
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  const [settingsFocus, setSettingsFocus] = useState<SettingsPanelFocus>('settings')
  const setupSectionSelections = useRef<Record<string, string>>({})
  const [panelSettings, setPanelSettings] = useState<ChatSettings>(() =>
    globalThis.structuredClone({ ...config.snapshot().settings, ...initialSettings })
  )
  const palette = useTheme()
  const panelTransition = useFadeTransition(appearance.animations)
  const [selection, setSelection] = useState(0)
  const rowViewportStart = useRef(0)
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
  const [profileBaseDir] = useState<string | null | undefined>(() => config.snapshot().profileBaseDir)
  const [importPath, setImportPath] = useState('')
  const [editing, setEditing] = useState<{ field: EditableField; value: string; cursor?: number }>()
  const [pathCompletionIndex, setPathCompletionIndex] = useState(-1)
  const [error, setError] = useState<string>()
  const [availableUpdate, setAvailableUpdate] = useState<string>()
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
  const [providerDetailSection, setProviderDetailSection] = useState<'models' | 'options'>('models')
  const providerSectionSelections = useRef<Partial<Record<ProviderSetupSection, string>>>({})
  const previousModelOffset = useRef<number | undefined>(undefined)
  const [deselectedModel, setDeselectedModel] = useState<string>()
  const providerListElement = useRef<DOMElement | null>(null)
  const modelListElement = useRef<DOMElement | null>(null)
  const modelSearchElement = useRef<DOMElement | null>(null)
  const modelPreviousElement = useRef<DOMElement | null>(null)
  const modelNextElement = useRef<DOMElement | null>(null)
  const modelSectionElement = useRef<DOMElement | null>(null)
  const optionsSectionElement = useRef<DOMElement | null>(null)
  const modelOptionsElement = useRef<DOMElement | null>(null)
  const connectionFieldsElement = useRef<DOMElement | null>(null)
  const setupEffortSliderElement = useRef<DOMElement | null>(null)
  const [quickstartProvider, setQuickstartProvider] = useState<ProviderId>('bedrock')
  const [selecting, setSelecting] = useState<{
    field: ProviderEnvironmentKey
    options: readonly SelectOption[]
    selection: number
  }>()
  const [frogAnimationId, setFrogAnimationId] = useState<number>()
  const rowElements = useRef(new Map<number, DOMElement>())
  const directoryElements = useRef(new Map<number, DOMElement>())
  const pathCompletionElements = useRef(new Map<number, DOMElement>())
  const selectOptionElements = useRef(new Map<number, DOMElement>())
  const choiceElements = useRef(new Map<SetupSettingsChoiceTarget, DOMElement>())
  const backElement = useRef<DOMElement | undefined>(undefined)
  const nextElement = useRef<DOMElement | undefined>(undefined)
  const settingsElement = useRef<DOMElement | undefined>(undefined)
  const settingsCategoriesElement = useRef<DOMElement | null>(null)
  const escapeHintElement = useRef<DOMElement | undefined>(undefined)
  const frogElement = useRef<DOMElement | undefined>(undefined)
  const frogPress = useRef<{ column: number; row: number } | undefined>(undefined)
  const hoverPointer = useRef<MouseInput | undefined>(undefined)
  const pressedElement = useRef<SetupControl | undefined>(undefined)
  const width = Math.max(1, columns)
  const height = Math.max(1, terminalRows)
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
  useEffect(() => {
    if (appearanceOnly) {
      return
    }
    let active = true
    void checkForUpdate().then((version) => {
      if (active) {
        setAvailableUpdate(version)
      }
    })
    return (): void => {
      active = false
    }
  }, [appearanceOnly, checkForUpdate])
  const isAppearance = step === APPEARANCE_STEP
  const isSettings = isAppearance && settingsReturn !== undefined
  const progress = appearanceOnly || isSettings ? undefined : setupStepProgress(flow, step)
  const progressHeight = progress ? 3 : 0
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
  const updateSettings = useCallback(
    (next: ChatSettings): void => {
      updateSetupSettings(next)
      setError(undefined)
      void config
        .setSettings(next)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    },
    [config, updateSetupSettings]
  )
  const isProviderSetup = (flow === 'quickstart' || flow === 'customize') && step === 1
  const isTools = flow === 'customize' && step === 3
  const isPlugins = flow === 'customize' && step === 4
  const isCapabilities = isTools || isPlugins
  const isData = flow === 'customize' && step === 5
  const isReview = flow === 'customize' && step === CUSTOMIZE_STEPS.length
  const isPermissions = flow === 'customize' && step === 6
  const isImport = flow === 'import' && step === 1
  const hasExternalActions =
    !isSettings && (isProviderSetup || isImport || isCapabilities || isAppearance || flow === 'customize')
  const bubbleWidth = Math.max(1, Math.min(isProviderSetup ? 144 : 112, width - 2))
  const stackedData = bubbleWidth < 72
  const stackedReview = bubbleWidth < 72
  const lockupWidth = Math.max(1, width - 2)
  const brandFrame = setupBrandFrame(lockupWidth, height)
  const lockupHeight = brandFrame.height
  const showBrand = lockupHeight > 1
  const brandHeight = showBrand ? lockupHeight + brandFrame.top : 0
  const {
    columns: openingColumns,
    rows: openingRows,
    rowGap: openingRowGap,
    gridWidth: openingGridWidth,
  } = openingGridLayout(lockupWidth)
  // The opening error sits one row below the grid and wraps to the grid's width.
  const openingErrorHeight = error ? wrapLines(error, Math.max(1, openingGridWidth)).length + 1 : 0
  // The Esc hint takes one row below the grid plus its gap.
  const openingContentHeight = height - brandHeight - navigationHeight - openingErrorHeight - 2
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
  const quickstartDetailColumnWidth = bubbleWidth - quickstartProviderColumnWidth
  const rowHeight = isAppearance
    ? 1
    : isProviderSetup
      ? 4
      : isCapabilities
        ? 1
        : isPermissions
          ? 2
          : flow === 'customize'
            ? step === 2
              ? 5
              : step === 5
                ? 4
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
  const quickstartExaSearchActive = flow === 'quickstart' && step === 1 && exaWebSearchActive(draft.profile)
  const quickstartWebSearchOffered = rows.some((row) => row.id === 'quickstart-web-search')
  const showModelOptionsPanel = splitQuickstart && quickstartDetailColumnWidth >= 66
  const quickstartOptionsColumnWidth = 32
  const quickstartModelColumnWidth =
    quickstartDetailColumnWidth - (showModelOptionsPanel ? quickstartOptionsColumnWidth : 0)
  const quickstartDetailContentWidth = Math.max(1, quickstartModelColumnWidth - 4)
  const bannerWarning = warning
    ? assessmentFacts.length > 0
      ? [
          PROVIDER_LABELS[inspectedProvider!],
          ...assessmentFacts.map((fact) => `${fact.label}: ${fact.value}`),
          '',
          warning,
        ].join('\n')
      : `${PROVIDER_LABELS[inspectedProvider!]}: ${warning}`
    : isTools || quickstartExaSearchActive
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
  const capabilityHeaderHeight = height >= 20 ? 3 : 1
  const warningChromeHeight = isCapabilities ? capabilityHeaderHeight + 3 : 1
  const bannerLines = (text: string): string[] =>
    wrapLines(`⚠ ${text}`, Math.max(1, bubbleWidth - 4)).slice(
      0,
      Math.max(0, availableBubbleHeight - rowHeight - warningChromeHeight - Number(error !== undefined))
    )
  const warningLines = bannerWarning && !splitQuickstart ? bannerLines(bannerWarning) : []
  // Reserve the Exa banner's space whether or not web_search is on, so toggling it doesn't resize the panel.
  const warningHeight =
    (isTools || (quickstartWebSearchOffered && !splitQuickstart)) &&
    !warning &&
    !providerSupportsWebSearch(draft.profile.model)
      ? bannerLines(EXA_WEB_SEARCH_WARNING).length
      : warningLines.length
  const warningGap =
    (isCapabilities || flow === 'quickstart') &&
    warningHeight > 0 &&
    (!isCapabilities ||
      availableBubbleHeight > warningChromeHeight + rowHeight + warningHeight + Number(error !== undefined))
      ? 1
      : 0
  const extraRows = Number(error !== undefined) + warningGap + warningHeight
  const capabilityContentHeight = Math.max(0, rows.length - 1) * rowHeight + capabilityHeaderHeight + 3
  const reviewSummaryWidth = Math.max(1, bubbleWidth - (stackedReview ? 6 : 36))
  const reviewSummaries = isReview
    ? rows.map((row) => {
        const lines = wrapLines(row.description, reviewSummaryWidth)
        return lines.length > 3
          ? [...lines.slice(0, 2), `${wrapLines(lines[2]!, Math.max(1, reviewSummaryWidth - 1))[0]}…`]
          : lines
      })
    : []
  const reviewButtonsOutlined = isReview && !stackedReview && availableBubbleHeight >= rows.length * 3 + 4 + extraRows
  const reviewContentHeights = reviewSummaries.map((lines) =>
    Math.max(reviewButtonsOutlined ? 3 : 1, lines.length + Number(stackedReview))
  )
  const reviewGap =
    !reviewButtonsOutlined &&
    availableBubbleHeight >=
      reviewContentHeights.reduce((total, row) => total + row, 0) + rows.length - 1 + 4 + extraRows
      ? 1
      : 0
  const contentRowHeights = isData
    ? rows.map((row) => dataRowHeight(row, stackedData))
    : isReview
      ? reviewContentHeights.map((row, index) => row + (index < rows.length - 1 ? reviewGap : 0))
      : []
  const bubbleHeight = isImport
    ? Math.min(10 + extraRows + (pathEditing ? importCompletionCapacity + 1 : 0), availableBubbleHeight)
    : isCapabilities
      ? Math.min(capabilityContentHeight + extraRows, availableBubbleHeight)
      : isPermissions
        ? availableBubbleHeight
        : isAppearance
          ? availableBubbleHeight
          : flow === 'customize' && !isProviderSetup
            ? Math.min(
                (isData || isReview
                  ? contentRowHeights.reduce((total, row) => total + row, 0)
                  : rows.length * rowHeight) +
                  4 +
                  extraRows,
                availableBubbleHeight
              )
            : availableBubbleHeight
  const panelChromeHeight = isProviderSetup ? 2 : isCapabilities ? capabilityHeaderHeight + 3 : 4
  const rowCapacity = Math.max(1, Math.floor((bubbleHeight - panelChromeHeight - extraRows) / rowHeight))
  const firstListRow = isCapabilities ? 1 : 0
  const contentRange =
    isData || isReview
      ? setupRowViewport(
          contentRowHeights,
          selection,
          Math.max(1, bubbleHeight - panelChromeHeight - extraRows),
          rowViewportStart.current
        )
      : undefined
  useEffect(() => {
    rowViewportStart.current = contentRange?.start ?? 0
  }, [contentRange?.start])
  const viewportStart =
    contentRange?.start ?? Math.max(firstListRow, Math.min(selection - rowCapacity + 1, rows.length - rowCapacity))
  const visibleRows = rows.slice(viewportStart, contentRange?.end ?? viewportStart + rowCapacity)
  const hiddenRowsBefore = viewportStart
  const hiddenRowsAfter = Math.max(0, rows.length - viewportStart - visibleRows.length)
  const customizeOverflowLabel = [
    hiddenRowsBefore > 0 ? `↑ ${hiddenRowsBefore} previous` : '',
    hiddenRowsAfter > 0 ? `↓ ${hiddenRowsAfter} more` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const visibleCapabilityRows = isCapabilities ? visibleRows.filter((row) => row.id !== 'select-all') : []
  const permissionModeHeight =
    bubbleWidth < 72 || bubbleHeight - extraRows < 14 ? 3 : bubbleHeight - extraRows < 18 ? 5 : 7
  const permissionToolCapacity = Math.max(
    1,
    Math.floor((bubbleHeight - panelChromeHeight - permissionModeHeight - 2 - extraRows) / rowHeight)
  )
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
  const modelOptionRows = providerReady
    ? providerConfigurationRows.filter((row) => row.id !== 'thinking' || reasoningRow !== undefined)
    : []
  const directoryRows = new Map(
    rows.flatMap((row, index) =>
      canUseNativePicker() && !row.disabled && (row.field === 'memoryDir' || row.field === 'skills')
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
  const quickstartVisibleProviderCount = Math.max(
    1,
    Math.floor(quickstartProviderListHeight / quickstartProviderRowHeight)
  )
  const quickstartProviderViewportStart = Math.max(
    0,
    Math.min(
      PROVIDER_IDS.indexOf(quickstartProvider) - quickstartVisibleProviderCount + 1,
      providerRows.length - quickstartVisibleProviderCount
    )
  )
  const visibleProviderRows = providerRows.slice(
    quickstartProviderViewportStart,
    quickstartProviderViewportStart + quickstartVisibleProviderCount
  )
  const quickstartFieldRowHeight = 5
  const middleFacts = splitQuickstart && showProviderConfiguration && !showModelOptionsPanel ? assessmentFacts : []
  const middleFactsHeight = middleFacts.length
  const middleDetailGap = middleFacts.length > 0 && warning ? 1 : 0
  const middleFieldGap = warning && providerConfigurationRows.length > 0 && !showModelOptionsPanel ? 1 : 0
  const quickstartFieldReserve = providerConfigurationRows.length > 0 ? quickstartFieldRowHeight : 0
  const middleWarningLines =
    splitQuickstart && showProviderConfiguration && !showModelOptionsPanel && warning
      ? wrapLines(warning, quickstartDetailContentWidth).slice(
          0,
          Math.max(
            0,
            quickstartBodyHeight - 2 - quickstartFieldReserve - middleFactsHeight - middleDetailGap - middleFieldGap
          )
        )
      : []
  const middleDetailHeight = middleFactsHeight + middleDetailGap + middleWarningLines.length + middleFieldGap
  const quickstartFieldCapacity = Math.max(
    1,
    Math.floor((quickstartBodyHeight - 2 - middleDetailHeight) / quickstartFieldRowHeight)
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
  const selectedModelOption = Math.max(
    0,
    modelOptionRows.findIndex((row) => row === rows[selection])
  )
  const modelOptionsContentHeight = Math.max(1, quickstartBodyHeight - 2)
  const compactModelOptions = modelOptionRows.length * 6 > modelOptionsContentHeight
  const reasoningControlHeight = compactModelOptions ? 4 : 6
  const webSearchControlHeight = modelOptionsContentHeight < 6 ? 4 : 6
  const visibleModelOptionRows =
    modelOptionRows.reduce(
      (height, row) => height + (row.id === 'thinking' ? reasoningControlHeight : webSearchControlHeight),
      0
    ) > modelOptionsContentHeight
      ? modelOptionRows.slice(selectedModelOption, selectedModelOption + 1)
      : modelOptionRows
  const quickstartModelRowHeight = 1
  const quickstartSearchHeight = quickstartBodyHeight >= 8 ? 3 : 1
  const quickstartModelCapacity = Math.max(
    1,
    Math.floor((quickstartBodyHeight - quickstartSearchHeight - 4) / quickstartModelRowHeight)
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
  const quickstartModelContentWidth = Math.max(1, quickstartDetailContentWidth - 4)
  const showModelIds = !showModelOptionsPanel && quickstartDetailContentWidth >= 44
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
  const providerSectionRows: Record<Exclude<ProviderSetupSection, 'actions'>, number[]> = {
    providers: [...providerRows.map((row) => rows.indexOf(row)), ...(refreshRow ? [rows.indexOf(refreshRow)] : [])],
    models: providerReady
      ? Array.from(
          { length: Math.max(0, quickstartSelectableRows - quickstartModelOffset) },
          (_, index) => quickstartModelOffset + index
        )
      : providerConfigurationRows.map((row) => rows.indexOf(row)),
    options: providerReady
      ? providerConfigurationRows
          .map((row) => rows.indexOf(row))
          .filter((index) => !rows[index]?.disabled && index !== hiddenReasoningRowIndex)
      : [],
  }
  const providerSections: ProviderSetupSection[] = [
    'providers',
    ...(modelPanelVisible || providerSectionRows.models.length > 0 ? (['models'] as const) : []),
    ...(providerSectionRows.options.length > 0 ? (['options'] as const) : []),
    'actions',
  ]
  const focusedProviderSection: ProviderSetupSection =
    focusedAction === 'back' || focusedAction === 'next'
      ? 'actions'
      : modelSearchFocused || selection >= quickstartModelOffset
        ? 'models'
        : providerSectionRows.providers.includes(selection)
          ? 'providers'
          : providerReady
            ? 'options'
            : 'models'
  const providerSelectionKey =
    focusedProviderSection === 'actions'
      ? focusedAction
      : modelSearchFocused
        ? 'search'
        : selection >= quickstartModelOffset
          ? filteredProviderModels[selection - quickstartModelOffset]?.id
          : rows[selection]?.id

  useEffect(() => {
    if (!isProviderSetup) {
      previousModelOffset.current = undefined
      return
    }
    const previousOffset = previousModelOffset.current
    previousModelOffset.current = quickstartModelOffset
    if (
      previousOffset !== undefined &&
      previousOffset !== quickstartModelOffset &&
      selection >= previousOffset &&
      !focusedAction &&
      !modelSearchFocused
    ) {
      setSelection(selection + quickstartModelOffset - previousOffset)
      return
    }
    if (providerSelectionKey !== undefined) {
      providerSectionSelections.current[focusedProviderSection] = providerSelectionKey
    }
  }, [
    focusedAction,
    focusedProviderSection,
    isProviderSetup,
    modelSearchFocused,
    providerSelectionKey,
    quickstartModelOffset,
    selection,
  ])

  const setupSectionRows: Partial<Record<SetupSection, number[]>> = {}
  if (!isProviderSetup && step > 0) {
    rows.forEach((row, index) => {
      if (row.disabled) return
      const section = setupRowSection(flow, step, row)
      ;(setupSectionRows[section] ??= []).push(index)
    })
  }
  const setupSections: SetupSection[] = [
    ...(isAppearance ? (['categories'] as const) : []),
    ...(Object.keys(setupSectionRows) as SetupSection[]),
    ...(hasExternalActions ? (['actions'] as const) : []),
  ]
  const focusedSetupSection: SetupSection =
    focusedAction === 'back' || focusedAction === 'next'
      ? 'actions'
      : isAppearance
        ? settingsFocus
        : setupRowSection(flow, step, rows[selection])
  const setupSelectionScope = `${flow ?? 'appearance'}:${step}${isAppearance ? `:${settingsCategory}` : ''}`

  useEffect(() => {
    if (isProviderSetup || step === 0 || focusedSetupSection === 'categories') return
    const key =
      focusedSetupSection === 'actions'
        ? focusedAction
        : focusedAction?.startsWith('browse:')
          ? `browse:${rows[selection]?.id}`
          : rows[selection]?.id
    if (key) setupSectionSelections.current[`${setupSelectionScope}:${focusedSetupSection}`] = key
  }, [focusedAction, focusedSetupSection, isProviderSetup, rows, selection, setupSelectionScope, step])

  const rowHighlighted = (index: number): boolean =>
    !saving && (hoveredControl === index || (focusedAction === undefined && !modelSearchFocused && index === selection))

  // Sized from every row, not just the visible ones, so descriptions stay aligned while scrolling.
  const capabilityLabelWidth = Math.max(
    0,
    ...rows.filter((row) => row.id !== 'select-all').map((row) => graphemes(row.label).length)
  )
  const showCapabilityDescriptions = bubbleWidth >= 64
  const renderCapabilityRows = (capabilityRows: readonly WizardRow[]): ReactElement => (
    <Box flexGrow={1} paddingX={1} flexDirection="column" overflow="hidden">
      {capabilityRows.map((row) => {
        const index = rows.indexOf(row)
        return (
          <Box
            key={row.id}
            ref={(element) => registerElement(rowElements.current, index, element)}
            height={1}
            flexShrink={0}
          >
            <Text color={accent}>{rowHighlighted(index) ? '›' : ' '}</Text>
            <SetupToggle checked={row.active === true} focused={rowHighlighted(index)} />
            <Box
              {...(showCapabilityDescriptions
                ? { width: capabilityLabelWidth + 1, flexShrink: 0 }
                : { flexGrow: 1, flexBasis: 0 })}
            >
              <Text
                color={row.active || rowHighlighted(index) ? accent : palette.foreground}
                bold={rowHighlighted(index)}
                wrap="truncate-end"
              >
                {row.label}
              </Text>
            </Box>
            {showCapabilityDescriptions ? (
              <Text
                {...(row.descriptionColor ? { color: row.descriptionColor } : { dimColor: true })}
                wrap="truncate-end"
              >
                {row.description}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )

  const renderChoices = (choices: NonNullable<WizardRow['choices']>, index: number, outlined = false): ReactElement => (
    <Box flexWrap="wrap" columnGap={1}>
      {choices.map((choice, choiceIndex) => {
        const target = `choice:${index}:${choiceIndex}` as const
        return (
          <Box
            key={choice.label}
            ref={(element) => registerElement(choiceElements.current, target, element)}
            paddingX={1}
            {...(outlined && bubbleWidth >= 38
              ? {
                  height: 3,
                  borderStyle: 'single' as const,
                  borderColor: choice.active || hoveredControl === target ? accent : undefined,
                  borderDimColor: !choice.active && hoveredControl !== target,
                }
              : {})}
          >
            <Text bold={choice.active} {...(choice.active ? { color: accent } : {})}>
              {choice.label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )

  const renderSetupRow = (row: WizardRow, index: number): ReactElement => {
    const activeEditing = editing?.field === row.field ? editing : undefined
    const defaultName = row.field === 'name' && row.description === DEFAULT_HARNESS_AGENT_CONFIG.name
    const highlighted = !row.disabled && rowHighlighted(index)
    return (
      <Box
        key={row.id}
        ref={(element) => registerElement(rowElements.current, index, element)}
        height={rowHeight}
        flexShrink={0}
        flexDirection="column"
        overflow="hidden"
      >
        <Text
          bold={row.field !== undefined || highlighted}
          color={highlighted || row.active ? accent : palette.foreground}
          dimColor={row.disabled === true}
          wrap="truncate-end"
        >
          {highlighted ? '› ' : '  '}
          {row.active === undefined ? '' : row.active ? '☑ ' : '☐ '}
          {row.label}
        </Text>
        {row.choices?.length ? (
          renderChoices(row.choices, index, true)
        ) : row.field ? (
          <Box flexGrow={1} flexDirection="row">
            <Box
              flexGrow={1}
              flexBasis={0}
              flexDirection="column"
              justifyContent={row.field === 'instructions' ? 'flex-start' : 'center'}
              paddingX={1}
              borderStyle="single"
              borderColor={highlighted ? accent : undefined}
              borderDimColor={!highlighted}
              overflow="hidden"
            >
              <EditableText
                value={activeEditing?.value ?? (defaultName ? '' : row.description)}
                cursor={
                  activeEditing
                    ? (activeEditing.cursor ?? graphemes(activeEditing.value).length)
                    : defaultName
                      ? 0
                      : graphemes(row.description).length
                }
                width={Math.max(1, bubbleWidth - (directoryRows.has(index) ? 21 : 8))}
                maxRows={row.field === 'instructions' ? Math.max(1, rowHeight - 3) : 1}
                active={Boolean(activeEditing)}
                {...(defaultName ? { placeholder: DEFAULT_HARNESS_AGENT_CONFIG.name } : {})}
              />
            </Box>
            {directoryRows.has(index) ? (
              <Box
                ref={(element) => registerElement(directoryElements.current, index, element)}
                width={12}
                marginLeft={1}
                flexShrink={0}
                alignItems="center"
                justifyContent="center"
                borderStyle="single"
                borderColor={
                  focusedAction === `browse:${index}` || hoveredControl === `browse:${index}` ? accent : undefined
                }
                borderDimColor={focusedAction !== `browse:${index}` && hoveredControl !== `browse:${index}`}
              >
                <Text bold wrap="truncate-end">
                  {choosingDirectory && focusedAction === `browse:${index}` ? 'Opening...' : 'Browse'}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            {row.description}
          </Text>
        )}
      </Box>
    )
  }

  const renderDataRow = (row: WizardRow, index: number): ReactElement => {
    const highlighted = !row.disabled && rowHighlighted(index)
    const activeEditing = editing?.field === row.field ? editing : undefined
    const stacked = stackedData && row.active === undefined
    const controlWidth = Math.max(1, bubbleWidth - 4 - (stackedData ? 0 : 22))
    const browseFocused = focusedAction === `browse:${index}` || hoveredControl === `browse:${index}`
    return (
      <Box
        key={row.id}
        ref={(element) => registerElement(rowElements.current, index, element)}
        height={dataRowHeight(row, stackedData)}
        flexShrink={0}
        flexDirection={stacked ? 'column' : 'row'}
        alignItems={stacked ? 'stretch' : 'center'}
        overflow="hidden"
      >
        <Box {...(stacked ? {} : stackedData ? { flexGrow: 1, flexBasis: 0 } : { width: 22 })} flexShrink={0}>
          <Text
            bold={highlighted}
            color={highlighted ? accent : palette.foreground}
            dimColor={row.disabled === true}
            wrap="truncate-end"
          >
            {highlighted ? '› ' : '  '}
            {row.label}
          </Text>
        </Box>
        {row.active !== undefined ? (
          <SetupToggle checked={row.active} focused={highlighted} />
        ) : row.choices ? (
          renderChoices(row.choices, index, true)
        ) : (
          <Box height={3} flexGrow={1} flexShrink={0} {...(stacked ? {} : { flexBasis: 0 })}>
            <Box
              flexGrow={1}
              flexBasis={0}
              paddingX={1}
              borderStyle="single"
              borderColor={highlighted ? accent : undefined}
              borderDimColor={!highlighted}
              overflow="hidden"
            >
              <EditableText
                value={activeEditing?.value ?? row.description}
                cursor={activeEditing?.cursor ?? graphemes(activeEditing?.value ?? row.description).length}
                width={Math.max(1, controlWidth - 4 - (directoryRows.has(index) ? 13 : 0))}
                maxRows={1}
                active={Boolean(activeEditing)}
              />
            </Box>
            {directoryRows.has(index) ? (
              <Box
                ref={(element) => registerElement(directoryElements.current, index, element)}
                width={12}
                marginLeft={1}
                flexShrink={0}
                alignItems="center"
                justifyContent="center"
                borderStyle="single"
                borderColor={browseFocused ? accent : undefined}
                borderDimColor={!browseFocused}
              >
                <Text bold wrap="truncate-end">
                  {choosingDirectory && browseFocused ? 'Opening...' : 'Browse'}
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>
    )
  }

  const renderReviewRow = (row: WizardRow, index: number): ReactElement => {
    const highlighted = rowHighlighted(index)
    const label = (
      <Text bold color={highlighted ? accent : palette.foreground} wrap="truncate-end">
        {highlighted ? '› ' : '  '}
        {row.label}
      </Text>
    )
    const edit = (
      <Box
        width={9}
        height={reviewButtonsOutlined ? 3 : 1}
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        {...(reviewButtonsOutlined
          ? {
              borderStyle: 'single' as const,
              borderColor: highlighted ? accent : undefined,
              borderDimColor: !highlighted,
            }
          : {})}
      >
        <Text bold={highlighted} color={highlighted ? accent : palette.foreground}>
          Edit →
        </Text>
      </Box>
    )
    return (
      <Box
        key={row.id}
        ref={(element) => registerElement(rowElements.current, index, element)}
        height={contentRowHeights[index]}
        paddingBottom={index < rows.length - 1 ? reviewGap : 0}
        flexShrink={0}
        flexDirection={stackedReview ? 'column' : 'row'}
        alignItems={stackedReview ? 'stretch' : 'center'}
        overflow="hidden"
      >
        {stackedReview ? (
          <Box justifyContent="space-between" flexShrink={0}>
            <Box flexGrow={1} flexBasis={0}>
              {label}
            </Box>
            {edit}
          </Box>
        ) : (
          <Box width={22} flexShrink={0}>
            {label}
          </Box>
        )}
        <Box {...(stackedReview ? { paddingLeft: 2 } : { width: reviewSummaryWidth, marginRight: 1 })} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {reviewSummaries[index]?.join('\n')}
          </Text>
        </Box>
        {stackedReview ? null : edit}
      </Box>
    )
  }

  const renderRefreshButton = (row: WizardRow, fieldWidth: number, compact = false): ReactElement => {
    const index = rows.indexOf(row)
    const buttonWidth = Math.min(fieldWidth, Math.max(13, Math.floor(fieldWidth / 2)))
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
          borderStyle="single"
          borderColor={rowHighlighted(index) ? accent : undefined}
          borderDimColor={!rowHighlighted(index)}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          <Text bold color={rowHighlighted(index) ? accent : palette.foreground} wrap="truncate-end">
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
      >
        <Text bold {...(rowHighlighted(index) ? { color: accent } : {})} wrap="truncate-end">
          {row.label}
        </Text>
        {editable ? (
          <>
            <Box
              width={fieldWidth}
              height={3}
              paddingX={1}
              alignItems="center"
              borderStyle="single"
              borderColor={rowHighlighted(index) ? accent : undefined}
              borderDimColor={!rowHighlighted(index)}
            >
              <EditableText
                value={activeEditing?.value ?? (row.selectOptions ? row.description : '')}
                cursor={activeEditing?.cursor ?? graphemes(activeEditing?.value ?? '').length}
                width={Math.max(1, fieldWidth - 4)}
                active={Boolean(activeEditing)}
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
          />
        ) : (
          <Text dimColor>{row.description || ' '}</Text>
        )}
      </Box>
    )
  }

  // The note keeps a fixed height so toggling Exa never resizes the panel.
  const renderQuickstartWebSearch = (row: WizardRow): ReactElement => {
    const index = rows.indexOf(row)
    return (
      <Box
        key={row.id}
        ref={(element) => registerElement(rowElements.current, index, element)}
        height={webSearchControlHeight}
        flexShrink={0}
        flexDirection="column"
      >
        <Text bold color={accent}>
          {rowHighlighted(index) ? '› ' : ''}
          {row.label}
        </Text>
        <Box flexShrink={0} alignSelf="flex-start" columnGap={1}>
          {row.choices?.map((choice, choiceIndex) => {
            const target = `choice:${index}:${choiceIndex}` as const
            const highlighted = !saving && (choice.active || hoveredControl === target)
            return (
              <Box
                key={choice.label}
                ref={(element) => registerElement(choiceElements.current, target, element)}
                paddingX={1}
                height={modelOptionsContentHeight >= 6 ? 3 : 1}
                borderStyle={modelOptionsContentHeight >= 6 ? 'single' : undefined}
                borderColor={highlighted ? accent : undefined}
                borderDimColor={!highlighted}
              >
                <Text bold={choice.active} {...(choice.active ? { color: accent } : { dimColor: true })}>
                  {choice.label}
                </Text>
              </Box>
            )
          })}
        </Box>
        {quickstartExaSearchActive ? (
          <>
            <Text color={palette.warning} wrap="truncate-end">
              ⚠ Third-party search via Exa
            </Text>
            <Text dimColor wrap="truncate-end">
              https://exa.ai/privacy-policy
            </Text>
          </>
        ) : (
          <>
            <Text dimColor wrap="truncate-end">
              {row.description}
            </Text>
            <Text> </Text>
          </>
        )}
      </Box>
    )
  }

  const renderProviderSelect = (state: NonNullable<typeof selecting>): ReactElement => {
    const capacity = Math.max(1, quickstartBodyHeight - middleDetailHeight - 3)
    const start = Math.max(0, Math.min(state.selection - capacity + 1, state.options.length - capacity))
    return (
      <Box width="100%" flexGrow={1} paddingX={1} flexDirection="column" overflow="hidden">
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

  const renderModelOptions = (fieldWidth: number): ReactElement => (
    <Box ref={modelOptionsElement} paddingX={1} flexGrow={1} flexDirection="column" overflow="hidden">
      {visibleModelOptionRows.map((row) =>
        row.id === 'thinking' && reasoningSlider ? (
          <Box key={row.id} height={reasoningControlHeight} flexShrink={0} flexDirection="column">
            <Text bold color={accent}>
              {rowHighlighted(reasoningRowIndex) ? '› ' : ''}
              Reasoning
            </Text>
            <EffortSlider
              slider={reasoningSlider}
              width={Math.max(1, Math.min(26, fieldWidth))}
              compact={compactModelOptions}
              focused={focusedProviderSection === 'options' && reasoningRowIndex === selection}
              paintBackground={false}
              onElement={(element) => {
                setupEffortSliderElement.current = element
                registerElement(rowElements.current, reasoningRowIndex, element)
              }}
            />
          </Box>
        ) : (
          renderQuickstartWebSearch(row)
        )
      )}
      {modelOptionRows.length === 0 ? <Text dimColor>No options for this model.</Text> : null}
    </Box>
  )

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
      if (isAppearance) setSettingsFocus('settings')
      setSelection(index)
      if (isProviderSetup && index >= quickstartModelOffset) {
        setProviderDetailSection('models')
        setModelViewportStart((start) =>
          revealPanelSelection(
            index - quickstartModelOffset,
            start,
            quickstartModelCapacity,
            filteredProviderModels.length
          )
        )
      } else if (isProviderSetup && index >= PROVIDER_IDS.length && rows[index]?.id !== 'refresh-provider') {
        setProviderDetailSection(providerReady ? 'options' : 'models')
      }
      if (isProviderSetup && index >= 0 && index < PROVIDER_IDS.length) {
        if (PROVIDER_IDS[index] !== quickstartProvider) {
          setProviderDetailSection('models')
          setModelQuery('')
          setModelViewportStart(0)
          setDeselectedModel(undefined)
        }
        setQuickstartProvider(PROVIDER_IDS[index]!)
        setSelecting(undefined)
        setEditing(undefined)
      }
    },
    [
      isProviderSetup,
      quickstartModelOffset,
      quickstartModelCapacity,
      filteredProviderModels.length,
      quickstartProvider,
      providerReady,
      rows,
      isAppearance,
    ]
  )

  const updateModelQuery = (query: string): void => {
    setModelQuery(query)
    setProviderDetailSection('models')
    setModelSearchFocused(true)
    setFocusedAction(undefined)
    setModelViewportStart(0)
    setSelection(quickstartModelOffset)
    setHoveredControl(undefined)
  }

  function focusProviderSection(direction: -1 | 1): void {
    const current = Math.max(0, providerSections.indexOf(focusedProviderSection))
    const section = providerSections[(current + direction + providerSections.length) % providerSections.length]!
    focusProviderSectionTarget(section, direction)
  }

  function focusProviderSectionTarget(section: ProviderSetupSection, direction: -1 | 1 = 1): void {
    if (section === 'models' || section === 'options') setProviderDetailSection(section)
    const previous = providerSectionSelections.current[section]
    if (section === 'actions') {
      const preferred = previous ?? (direction < 0 ? 'next' : 'back')
      setFocusedAction(preferred === 'next' && canContinue ? 'next' : 'back')
      setModelSearchFocused(false)
      return
    }
    if (
      section === 'models' &&
      modelPanelVisible &&
      (previous === 'search' || providerSectionRows.models.length === 0)
    ) {
      setModelSearchFocused(true)
      setFocusedAction(undefined)
      return
    }
    const candidates = providerSectionRows[section].filter((index) => !rows[index]?.disabled)
    const remembered = candidates.find((index) =>
      index >= quickstartModelOffset
        ? filteredProviderModels[index - quickstartModelOffset]?.id === previous
        : rows[index]?.id === previous
    )
    const defaultRow =
      section === 'providers'
        ? PROVIDER_IDS.indexOf(quickstartProvider)
        : section === 'models' && modelPanelVisible
          ? candidates.find(
              (index) =>
                `${quickstartProvider}/${filteredProviderModels[index - quickstartModelOffset]?.id}` ===
                draft.profile.model
            )
          : undefined
    const target = remembered ?? defaultRow ?? candidates[0]
    if (target === undefined) return
    selectWizardRow(target)
    const row = rows[target]
    if (row?.field && row.input === true && !row.selectOptions) row.activate()
  }

  function focusSetupSectionTarget(section: SetupSection, direction: -1 | 1 = 1): void {
    const previous = setupSectionSelections.current[`${setupSelectionScope}:${section}`]
    if (section === 'actions') {
      const preferred = previous ?? (direction < 0 ? 'next' : 'back')
      setFocusedAction(preferred === 'next' && canContinue ? 'next' : 'back')
      return
    }
    setFocusedAction(undefined)
    if (section === 'categories') {
      setSettingsFocus('categories')
      return
    }
    const candidates = setupSectionRows[section] ?? []
    const rowId = previous?.startsWith('browse:') ? previous.slice('browse:'.length) : previous
    const target = candidates.find((index) => rows[index]?.id === rowId) ?? candidates[0]
    if (target === undefined) return
    selectWizardRow(target)
    if (previous?.startsWith('browse:') && directoryRows.has(target)) setFocusedAction(`browse:${target}`)
  }

  function focusSetupSection(direction: -1 | 1): void {
    const current = Math.max(0, setupSections.indexOf(focusedSetupSection))
    const target = setupSections[(current + direction + setupSections.length) % setupSections.length]
    if (target) focusSetupSectionTarget(target, direction)
  }

  function selectSettingsCategory(category: SettingsCategory): void {
    setSettingsCategory(category)
    setSettingsFocus('categories')
    setSelection(0)
    setFocusedAction(undefined)
  }

  function paginateModels(direction: -1 | 1): void {
    const lastPageStart = Math.max(0, filteredProviderModels.length - quickstartModelCapacity)
    const nextStart = Math.max(
      0,
      Math.min(lastPageStart, quickstartModelViewportStart + direction * quickstartModelCapacity)
    )
    setModelViewportStart(nextStart)
    setProviderDetailSection('models')
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
      setProviderDetailSection('models')
      setFlow(nextFlow)
      setStep(1)
      setError(undefined)
      if (nextFlow !== 'import') {
        const provider = providerFromModel(draft.profile.model) ?? 'bedrock'
        if (nextFlow === 'quickstart') {
          setDraft(quickstartDraft(provider, effectiveEnvironment))
        }
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
      completeSetup(completedDraft)
      return
    }
    if (step < CUSTOMIZE_STEPS.length) {
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
        if (onExit) onExit()
        else onCancel?.(0)
        return
      }
      panelTransition.transition(() => {
        setFlow(undefined)
        setStep(0)
        setSelection(0)
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
    leaveEdit()
    setSelecting(undefined)
    panelTransition.transition(() => {
      setSettingsReturn({ flow, step, selection })
      setSettingsCategory(DEFAULT_SETTINGS_CATEGORY)
      setSettingsFocus('settings')
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
    const value = editing.value.trim() || (editing.field === 'name' ? DEFAULT_HARNESS_AGENT_CONFIG.name : '')
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
      providerSectionSelections.current.models = model.id
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
    if (flow === 'customize' && step === CUSTOMIZE_STEPS.length) {
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
    hoverPointer.current = undefined
    setHoveredControl(undefined)
    pressedElement.current = undefined
  }, [step, flow, quickstartProvider, selecting?.field, modelViewportStart])

  useEffect(() => {
    pressedElement.current = undefined
    frogPress.current = undefined
    const mouse = hoverPointer.current
    if (step !== 0 || !mouse) {
      setHoveredControl(undefined)
      return
    }
    const row = elementAtMouse(rowElements.current, mouse)
    const settings = settingsElement.current && elementContainsMouse(settingsElement.current, mouse)
    const escapeHint = escapeHintElement.current && elementContainsMouse(escapeHintElement.current, mouse)
    setHoveredControl(row ?? (settings ? 'settings' : escapeHint ? 'escape' : undefined))
  }, [width, height])

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

  const frogClockMs = useBrandAnimation(frogAnimationId)
  const frogElapsedMs = useBrandAnimationFrame(frogClockMs, brandFrame.width, brandFrame.height)

  useInput((input, key) => {
    if (panelTransition.transitioning) return
    const mouse = parseMouseInput(input)
    if (mouse) {
      hoverPointer.current = mouse
      const scroll = mouseScrollDirection(mouse)
      if (scroll !== undefined) {
        hoverPointer.current = undefined
        setHoveredControl(undefined)
        if (
          isProviderSetup &&
          providerListElement.current &&
          elementContainsMouse(providerListElement.current, mouse)
        ) {
          const current = PROVIDER_IDS.indexOf(quickstartProvider)
          const target = providerRows[Math.max(0, Math.min(providerRows.length - 1, current + scroll))]
          if (target) selectWizardRow(rows.indexOf(target))
        } else if (
          isProviderSetup &&
          connectionFieldsElement.current &&
          elementContainsMouse(connectionFieldsElement.current, mouse)
        ) {
          if (selecting) return
          const candidates = providerSectionRows.models.filter((index) => !rows[index]?.disabled)
          const current = Math.max(
            0,
            candidates.findIndex((index) => rows[index]?.id === providerSectionSelections.current.models)
          )
          const target = candidates[Math.max(0, Math.min(candidates.length - 1, current + scroll))]
          if (target !== undefined) {
            leaveEdit()
            selectWizardRow(target)
          }
        } else if (
          isProviderSetup &&
          modelOptionsElement.current &&
          elementContainsMouse(modelOptionsElement.current, mouse)
        ) {
          const candidates = providerSectionRows.options
          const current = Math.max(
            0,
            candidates.findIndex((index) => rows[index]?.id === providerSectionSelections.current.options)
          )
          const target = candidates[Math.max(0, Math.min(candidates.length - 1, current + scroll))]
          if (target !== undefined) selectWizardRow(target)
        } else if (
          isProviderSetup &&
          modelListElement.current &&
          elementContainsMouse(modelListElement.current, mouse)
        ) {
          setModelViewportStart((start) =>
            scrollPanelViewport(start, scroll, filteredProviderModels.length, quickstartModelCapacity)
          )
        } else if (isAppearance) {
          const target = elementAtMouse(choiceElements.current, mouse)
          if (
            target?.startsWith('category:') ||
            (settingsCategoriesElement.current && elementContainsMouse(settingsCategoriesElement.current, mouse))
          ) {
            const current = SETTINGS_CATEGORIES.findIndex(({ id }) => id === settingsCategory)
            const category =
              SETTINGS_CATEGORIES[Math.max(0, Math.min(SETTINGS_CATEGORIES.length - 1, current + scroll))]
            if (category) selectSettingsCategory(category.id)
          } else {
            selectWizardRow(scrollPanelViewport(selection, scroll, rows.length, 1))
          }
        } else if (!isProviderSetup && (flow === 'customize' || isImport)) {
          const pointedRow = elementAtMouse(rowElements.current, mouse)
          const section = setupRowSection(flow, step, rows[pointedRow ?? selection])
          const candidates = setupSectionRows[section] ?? []
          const current = Math.max(0, candidates.indexOf(selection))
          const target = candidates[Math.max(0, Math.min(candidates.length - 1, current + scroll))]
          if (target !== undefined) {
            leaveEdit()
            selectWizardRow(target)
          }
        } else if (flow === 'customize') {
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
      const escapeHint = escapeHintElement.current ? elementContainsMouse(escapeHintElement.current, mouse) : false
      const frog = frogElement.current ? elementContainsMouse(frogElement.current, mouse) : false
      const search = modelSearchElement.current ? elementContainsMouse(modelSearchElement.current, mouse) : false
      const modelSection = modelSectionElement.current
        ? elementContainsMouse(modelSectionElement.current, mouse)
        : false
      const optionsSection = optionsSectionElement.current
        ? elementContainsMouse(optionsSectionElement.current, mouse)
        : false
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
        modelSection || optionsSection
          ? modelSection
            ? 'section:models'
            : 'section:options'
          : modelsPrevious || modelsNext
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
                        : escapeHint
                          ? 'escape'
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
            selectWizardRow(reasoningRowIndex)
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
        } else if (target === 'back' || target === 'next' || target === 'escape' || target === 'settings') {
          setFocusedAction(target)
          setModelSearchFocused(false)
        } else if (target === 'search') {
          setProviderDetailSection('models')
          setModelSearchFocused(true)
          setFocusedAction(undefined)
          setEditing(undefined)
        } else if (target === 'models-previous' || target === 'models-next') {
          pressedElement.current = undefined
          paginateModels(target === 'models-previous' ? -1 : 1)
          return
        } else if (choice?.startsWith('choice:')) {
          selectWizardRow(Number(choice.split(':')[1]))
        } else if (choice?.startsWith('category:')) {
          setSettingsFocus('categories')
          setFocusedAction(undefined)
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
          selectSettingsCategory(pressed.slice('category:'.length) as SettingsCategory)
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
        } else if (pressed === 'escape' && escapeHint) {
          moveBack()
        } else if (pressed === 'models-previous' && modelsPrevious) {
          paginateModels(-1)
        } else if (pressed === 'models-next' && modelsNext) {
          paginateModels(1)
        } else if (pressed === 'section:models' && modelSection) {
          focusProviderSectionTarget('models')
        } else if (pressed === 'section:options' && optionsSection) {
          focusProviderSectionTarget('options')
        }
      } else if (mouse.action === 'move') {
        // Opening cards have no hover fill; pointing at one selects it.
        if (step === 0 && typeof target === 'number') {
          selectWizardRow(target)
        }
        setHoveredControl(isCapabilities && row !== undefined ? row : target)
      }
      return
    }

    hoverPointer.current = undefined
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
      } else if (key.tab) {
        setSelecting(undefined)
        focusProviderSection(key.shift ? -1 : 1)
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
        if ((key.tab && !key.shift) || (key.return && pathCompletionIndex >= 0)) {
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
      if (isProviderSetup) {
        focusProviderSection(key.shift ? -1 : 1)
        return
      }
      if (step === 0) {
        const sections = [undefined, 'escape', 'settings'] as const
        const current = sections.findIndex((section) => section === focusedAction)
        setFocusedAction(sections[(current + (key.shift ? -1 : 1) + sections.length) % sections.length])
        setModelSearchFocused(false)
        return
      }
      focusSetupSection(key.shift ? -1 : 1)
    } else if (isAppearance && !focusedAction && settingsFocus === 'categories') {
      const current = SETTINGS_CATEGORIES.findIndex(({ id }) => id === settingsCategory)
      const target = key.home
        ? 0
        : key.end
          ? SETTINGS_CATEGORIES.length - 1
          : key.upArrow
            ? Math.max(0, current - 1)
            : key.downArrow
              ? Math.min(SETTINGS_CATEGORIES.length - 1, current + 1)
              : undefined
      if (target !== undefined) selectSettingsCategory(SETTINGS_CATEGORIES[target]!.id)
      else if (key.return || key.rightArrow) focusSetupSectionTarget('settings')
    } else if (focusedAction) {
      if (focusedAction === 'escape') {
        if (key.return || input === ' ') moveBack()
      } else if (focusedAction === 'settings') {
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
        return
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
    } else if (
      (isCapabilities || isData) &&
      (key.leftArrow || key.rightArrow) &&
      rows[selection]?.active !== undefined
    ) {
      const row = rows[selection]!
      if (!row.disabled && row.active !== key.rightArrow) row.activate()
    } else if (
      isProviderSetup &&
      (key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.home ||
        key.end ||
        key.pageUp ||
        key.pageDown)
    ) {
      if (focusedProviderSection === 'actions') return
      if (modelPanelVisible && focusedProviderSection === 'models' && (key.pageUp || key.pageDown)) {
        paginateModels(key.pageUp ? -1 : 1)
        return
      }
      const candidates = providerSectionRows[focusedProviderSection].filter((index) => !rows[index]?.disabled)
      const current = candidates.indexOf(selection)
      const target = key.home
        ? candidates[0]
        : key.end
          ? candidates.at(-1)
          : key.upArrow || key.pageUp
            ? candidates[Math.max(0, current - 1)]
            : key.downArrow || key.pageDown
              ? candidates[Math.min(candidates.length - 1, current + 1)]
              : undefined
      if (target !== undefined) selectWizardRow(target)
    } else if (
      step > 0 &&
      !isProviderSetup &&
      (key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.home ||
        key.end ||
        key.pageUp ||
        key.pageDown)
    ) {
      if (key.rightArrow && directoryRows.has(selection)) {
        setFocusedAction(`browse:${selection}`)
        return
      }
      const candidates = setupSectionRows[focusedSetupSection] ?? []
      const current = Math.max(0, candidates.indexOf(selection))
      const target = key.home
        ? candidates[0]
        : key.end
          ? candidates.at(-1)
          : key.upArrow ||
              key.pageUp ||
              (isImport && key.leftArrow) ||
              (isPermissions && focusedSetupSection === 'modes' && key.leftArrow)
            ? candidates[Math.max(0, current - 1)]
            : key.downArrow ||
                key.pageDown ||
                (isImport && key.rightArrow) ||
                (isPermissions && focusedSetupSection === 'modes' && key.rightArrow)
              ? candidates[Math.min(candidates.length - 1, current + 1)]
              : undefined
      if (target !== undefined) selectWizardRow(target)
    } else if (
      step === 0 &&
      openingColumns === 2 &&
      (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
    ) {
      selectWizardRow(
        openingNeighbor(
          selection,
          key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.upArrow ? 'up' : 'down',
          openingColumns
        )
      )
    } else if (key.upArrow || key.leftArrow) {
      moveRow(-1)
    } else if (key.downArrow || key.rightArrow) {
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
    (flow === 'quickstart' && step === 1) ||
    (flow === 'customize' && step === CUSTOMIZE_STEPS.length) ||
    (flow === 'import' && step === 1)
  const primaryLabel = saving
    ? 'Saving...'
    : isSetupCompletion
      ? deferred || !config.needsSetup()
        ? 'Save and Launch'
        : 'Launch Strands harness'
      : 'Continue'
  const escapeAction = editing || selecting ? 'cancel' : 'back'
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
            ? `Click/Enter ${isReview ? 'edit' : 'choose'} · ↑↓ move`
            : `Click or Enter to ${isReview ? 'edit' : 'choose'} · Arrow keys (↑↓) to move`,
        width < 32
          ? 'Shift+Tab'
          : width < 60
            ? step === 0
              ? 'Tab/Shift+Tab focus'
              : `Tab/Shift+Tab focus · Esc ${escapeAction}`
            : step === 0
              ? 'Tab / Shift+Tab: grid ↔ Esc ↔ Settings'
              : `Tab / Shift+Tab to move focus · Esc to ${escapeAction}`,
      ]

  const settingsHovered = hoveredControl === 'settings'
  const settingsButton = !appearanceOnly ? (
    <Box
      ref={(element) => {
        settingsElement.current = element ?? undefined
      }}
      height={1}
      flexShrink={0}
    >
      <Text color={settingsHovered || focusedAction === 'settings' ? accent : palette.foreground}>
        {isSettings ? 'Back' : '/settings'}
      </Text>
    </Box>
  ) : null

  return (
    <Box width={width} height={height} paddingX={1} flexDirection="column" overflow="hidden">
      {showBrand ? (
        <SetupBrand
          frame={brandFrame}
          containerWidth={lockupWidth}
          appearance={appearance}
          animationId={frogAnimationId}
          {...(introStartedAt !== undefined ? { introStartedAt } : {})}
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
            showSelection={focusedAction === undefined}
            topGap={openingTopGap}
            animate={appearance.animations}
            {...(error ? { error } : {})}
            {...(availableUpdate ? { availableUpdate } : {})}
            escapeHint={escapeHint}
            escapeFocused={focusedAction === 'escape'}
            escapeHovered={hoveredControl === 'escape'}
            onEscapeElement={(element) => {
              escapeHintElement.current = element ?? undefined
            }}
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
                  {...(progress.label ? { label: progress.label } : {})}
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
              {...(!splitQuickstart && !isAppearance && bubbleHeight >= 3
                ? {
                    borderStyle: 'single' as const,
                    borderColor: focusedAction === 'back' || focusedAction === 'next' ? undefined : accent,
                    borderDimColor: focusedAction === 'back' || focusedAction === 'next',
                  }
                : {})}
            >
              {!isAppearance && flow === 'customize' && !isProviderSetup && !isCapabilities ? (
                <Box paddingX={1} marginBottom={1} justifyContent="space-between" flexShrink={0}>
                  <Text bold color={accent}>
                    {CUSTOMIZE_STEPS[step - 1]}
                  </Text>
                  {customizeOverflowLabel ? <Text dimColor>{customizeOverflowLabel}</Text> : null}
                </Box>
              ) : null}
              {isCapabilities ? (
                <>
                  <Box
                    paddingX={1}
                    height={capabilityHeaderHeight}
                    marginBottom={1}
                    justifyContent="space-between"
                    alignItems="center"
                    flexShrink={0}
                  >
                    <Text bold color={accent}>
                      {isTools ? 'Tools' : bubbleWidth < 64 ? 'Plugins' : 'Plugins & features'}
                    </Text>
                    <Text dimColor>
                      {[
                        hiddenRowsBefore > 1 ? `↑ ${hiddenRowsBefore - 1}` : '',
                        hiddenRowsAfter > 0 ? `↓ ${hiddenRowsAfter}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    <Box
                      ref={(element) => registerElement(rowElements.current, 0, element)}
                      paddingX={1}
                      height={capabilityHeaderHeight}
                      borderStyle={capabilityHeaderHeight >= 3 ? 'single' : undefined}
                      borderColor={rowHighlighted(0) ? accent : undefined}
                      borderDimColor={!rowHighlighted(0)}
                    >
                      <Text bold color={rowHighlighted(0) ? accent : palette.foreground}>
                        {rows[0]!.label}
                      </Text>
                    </Box>
                  </Box>
                  {renderCapabilityRows(visibleCapabilityRows)}
                </>
              ) : isImport ? (
                <Box flexGrow={1} paddingX={1} paddingY={1} flexDirection="column" overflow="hidden">
                  <Text bold wrap="truncate-end">
                    Import an agent
                  </Text>
                  <Box marginTop={1}>
                    <Text bold {...(selection === 0 ? { color: accent } : {})} wrap="truncate-end">
                      Path to ZIP, file, or folder
                    </Text>
                  </Box>
                  <Box height={3} flexShrink={0} flexDirection="row">
                    <Box
                      ref={(element) => registerElement(rowElements.current, 0, element)}
                      flexGrow={1}
                      flexBasis={0}
                      paddingX={1}
                      flexDirection="column"
                      justifyContent="center"
                      borderStyle="single"
                      borderColor={rowHighlighted(0) ? accent : undefined}
                      borderDimColor={!rowHighlighted(0)}
                    >
                      <EditableText
                        value={editing?.field === 'importPath' ? editing.value : importPath}
                        cursor={
                          editing?.field === 'importPath'
                            ? (editing.cursor ?? graphemes(editing.value).length)
                            : graphemes(importPath).length
                        }
                        width={Math.max(1, bubbleWidth - (canUseNativePicker() ? 21 : 8))}
                        active={editing?.field === 'importPath'}
                      />
                    </Box>
                    {canUseNativePicker() ? (
                      <Box
                        ref={(element) => registerElement(rowElements.current, 1, element)}
                        width={12}
                        flexShrink={0}
                        marginLeft={1}
                        alignItems="center"
                        justifyContent="center"
                        borderStyle="single"
                        borderColor={rowHighlighted(1) && !choosingDirectory ? accent : undefined}
                        borderDimColor={!rowHighlighted(1) || choosingDirectory}
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
                        >
                          <Text
                            color={
                              pathCompletionIndex === index || hoveredControl === `completion:${index}`
                                ? accent
                                : palette.foreground
                            }
                            bold={pathCompletionIndex === index}
                            wrap="truncate-end"
                          >
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
                  <PanelSection
                    width={quickstartProviderColumnWidth}
                    focused={focusedProviderSection === 'providers'}
                    header={<Text dimColor>Providers</Text>}
                    meta={[
                      quickstartProviderViewportStart > 0 ? '↑' : '',
                      quickstartProviderViewportStart + visibleProviderRows.length < providerRows.length ? '↓' : '',
                    ].join('')}
                  >
                    <Box
                      ref={providerListElement}
                      height={quickstartProviderListHeight}
                      flexShrink={0}
                      flexDirection="column"
                      overflow="hidden"
                    >
                      <ProviderList
                        items={visibleProviderRows.map((row) => ({
                          id: row.id,
                          label:
                            quickstartProviderColumnWidth < 29
                              ? SHORT_PROVIDER_LABELS[row.id as ProviderId]
                              : row.label,
                          description: row.description,
                          ...(row.status ? { status: row.status } : {}),
                        }))}
                        selected={quickstartProvider}
                        width={quickstartProviderColumnWidth - 2}
                        rowHeight={quickstartProviderRowHeight}
                        focused={focusedProviderSection === 'providers'}
                        paintBackground={false}
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
                  </PanelSection>
                  <Box width={quickstartDetailColumnWidth} flexShrink={0} flexDirection="row" overflow="hidden">
                    {showProviderConfiguration ? (
                      <>
                        <PanelSection
                          width={quickstartModelColumnWidth}
                          focused={focusedProviderSection === 'models'}
                          header={<Text dimColor>Connection</Text>}
                        >
                          <Box
                            ref={connectionFieldsElement}
                            paddingX={1}
                            flexGrow={1}
                            flexDirection="column"
                            overflow="hidden"
                          >
                            {middleFacts.length > 0 || middleWarningLines.length > 0 ? (
                              <Box marginBottom={middleFieldGap} flexShrink={0} flexDirection="column">
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
                                  renderProviderField(row, quickstartDetailContentWidth)
                                )}
                          </Box>
                        </PanelSection>
                        {showModelOptionsPanel ? (
                          <PanelSection
                            width={quickstartOptionsColumnWidth}
                            focused={false}
                            header={<Text dimColor>Connection status</Text>}
                          >
                            <Box paddingX={1} flexDirection="column">
                              {assessmentFacts.map((fact) => (
                                <Text key={fact.label}>
                                  <Text dimColor>{fact.label}: </Text>
                                  <Text bold color={palette[fact.status]}>
                                    {fact.value}
                                  </Text>
                                </Text>
                              ))}
                              <Box marginTop={assessmentFacts.length > 0 ? 1 : 0}>
                                {warning ? (
                                  <Text color={palette[providerWarningStatus]}>{warning}</Text>
                                ) : (
                                  <Text dimColor>Connect this provider to browse its models.</Text>
                                )}
                              </Box>
                            </Box>
                          </PanelSection>
                        ) : null}
                      </>
                    ) : (
                      <Box flexGrow={1} flexDirection="row" overflow="hidden">
                        <PanelSection
                          width={quickstartModelColumnWidth}
                          focused={
                            focusedProviderSection === 'models' ||
                            (!showModelOptionsPanel && focusedProviderSection === 'options')
                          }
                          meta={
                            !showModelOptionsPanel &&
                            providerDetailSection === 'options' &&
                            visibleModelOptionRows.length < modelOptionRows.length
                              ? '↕'
                              : ''
                          }
                          header={
                            !showModelOptionsPanel && modelOptionRows.length > 0 ? (
                              <Box columnGap={1}>
                                <Box ref={modelSectionElement}>
                                  <Text
                                    color={
                                      providerDetailSection === 'models' || hoveredControl === 'section:models'
                                        ? accent
                                        : palette.muted
                                    }
                                    bold={providerDetailSection === 'models'}
                                  >
                                    Models
                                  </Text>
                                </Box>
                                <Text dimColor>│</Text>
                                <Box ref={optionsSectionElement}>
                                  <Text
                                    color={
                                      providerDetailSection === 'options' || hoveredControl === 'section:options'
                                        ? accent
                                        : palette.muted
                                    }
                                    bold={providerDetailSection === 'options'}
                                  >
                                    Options
                                  </Text>
                                </Box>
                              </Box>
                            ) : (
                              <Text dimColor>Models</Text>
                            )
                          }
                        >
                          {!showModelOptionsPanel &&
                          providerDetailSection === 'options' &&
                          modelOptionRows.length > 0 ? (
                            renderModelOptions(quickstartDetailContentWidth)
                          ) : (
                            <Box
                              ref={modelListElement}
                              paddingX={1}
                              flexGrow={1}
                              flexDirection="column"
                              overflow="hidden"
                            >
                              <Box
                                ref={modelSearchElement}
                                height={quickstartSearchHeight}
                                paddingX={1}
                                flexShrink={0}
                                borderStyle={quickstartSearchHeight >= 3 ? 'single' : undefined}
                                borderColor={modelSearchFocused || hoveredControl === 'search' ? accent : undefined}
                                borderDimColor={!modelSearchFocused && hoveredControl !== 'search'}
                              >
                                <Text wrap="truncate-end">
                                  {modelSearchFocused ? (
                                    <>
                                      {modelQuery}
                                      <Cursor />
                                    </>
                                  ) : (
                                    <Text dimColor>/ {modelQuery || 'Search models'}</Text>
                                  )}
                                </Text>
                              </Box>
                              {showModelPagination ? (
                                <Box ref={modelPreviousElement} width="100%" height={1} paddingX={1} flexShrink={0}>
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
                                  <Text dimColor>
                                    {modelQuery.trim() ? 'No matching models' : 'No models reported'}
                                  </Text>
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
                                        >
                                          <Box width={2} flexShrink={0}>
                                            <Text {...(active || highlighted ? { color: accent, bold: true } : {})}>
                                              {active ? '✓ ' : highlighted ? '› ' : '  '}
                                            </Text>
                                          </Box>
                                          <Box
                                            {...(showModelIds
                                              ? { width: quickstartModelNameWidth, flexShrink: 0 }
                                              : { flexGrow: 1 })}
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
                                          {showModelIds ? (
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
                                <Box ref={modelNextElement} width="100%" height={1} paddingX={1} flexShrink={0}>
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
                            </Box>
                          )}
                        </PanelSection>
                        {showModelOptionsPanel ? (
                          <PanelSection
                            width={quickstartOptionsColumnWidth}
                            focused={focusedProviderSection === 'options'}
                            header={<Text dimColor>Model options</Text>}
                            meta={visibleModelOptionRows.length < modelOptionRows.length ? '↕' : ''}
                          >
                            {renderModelOptions(quickstartOptionsColumnWidth - 4)}
                          </PanelSection>
                        ) : null}
                      </Box>
                    )}
                  </Box>
                </Box>
              ) : isAppearance ? (
                <SetupSettingsPanel
                  rows={visibleRows}
                  allRows={rows}
                  focus={settingsFocus}
                  focusActive={focusedAction !== 'back' && focusedAction !== 'next'}
                  category={settingsCategory}
                  start={viewportStart}
                  selected={selection}
                  width={bubbleWidth}
                  height={bubbleHeight}
                  {...(typeof hoveredControl === 'string' ? { hoveredControl } : {})}
                  {...(typeof hoveredControl === 'number' ? { hoveredRow: hoveredControl } : {})}
                  onRowElement={(index, element) => registerElement(rowElements.current, index, element)}
                  onChoiceElement={(target, element) => registerElement(choiceElements.current, target, element)}
                  onCategoriesElement={(element) => {
                    settingsCategoriesElement.current = element
                  }}
                />
              ) : isPermissions ? (
                <Box flexGrow={1} paddingX={1} flexDirection="column" overflow="hidden">
                  <Box height={permissionModeHeight} flexShrink={0}>
                    {rows.slice(0, 3).map((row, index) => (
                      <Box
                        key={row.id}
                        ref={(element) => registerElement(rowElements.current, index, element)}
                        flexGrow={1}
                        flexBasis={0}
                        height={permissionModeHeight}
                        marginRight={index < 2 ? 1 : 0}
                        paddingX={bubbleWidth >= 72 ? 1 : 0}
                        borderStyle="single"
                        borderColor={rowHighlighted(index) || row.active ? accent : undefined}
                        borderDimColor={!rowHighlighted(index) && !row.active}
                        flexDirection="column"
                        justifyContent="center"
                        overflow="hidden"
                      >
                        <Text
                          bold
                          color={row.active || rowHighlighted(index) ? accent : palette.foreground}
                          wrap="truncate-end"
                        >
                          {row.active ? '✓ ' : ''}
                          {bubbleWidth < 72 ? ['Ask', 'Allow all', 'Custom'][index] : row.label}
                        </Text>
                        {permissionModeHeight >= 5 ? (
                          <Text dimColor wrap={permissionModeHeight >= 7 ? 'wrap' : 'truncate-end'}>
                            {row.description}
                          </Text>
                        ) : null}
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
                          >
                            <Text
                              bold={rowHighlighted(index)}
                              color={row.active || rowHighlighted(index) ? accent : palette.foreground}
                              wrap="truncate-end"
                            >
                              {rowHighlighted(index) ? '› ' : '  '}
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
                      <Text dimColor>{rows.find((row) => row.active)?.description}</Text>
                    </Box>
                  )}
                </Box>
              ) : selecting ? (
                renderProviderSelect(selecting)
              ) : (
                <Box flexGrow={1} paddingX={isProviderSetup ? 0 : 1} flexDirection="column" overflow="hidden">
                  {visibleRows.map((row, visibleIndex) => {
                    const index = viewportStart + visibleIndex
                    if (isReview) return renderReviewRow(row, index)
                    if (isData) return renderDataRow(row, index)
                    if (!isProviderSetup) return renderSetupRow(row, index)
                    if (row.id === 'refresh-provider') {
                      return renderRefreshButton(row, bubbleWidth - 2)
                    }
                    if (row.status) {
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
                          width={Math.max(1, bubbleWidth - 2)}
                          rowHeight={rowHeight}
                          focused={focusedProviderSection === 'providers'}
                          paintBackground={false}
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
                      >
                        <Box paddingX={row.field ? 1 : 0} justifyContent="space-between" flexShrink={0}>
                          <Text
                            bold={row.field !== undefined}
                            {...(!row.disabled && index === selection ? { color: accent } : {})}
                            dimColor={row.disabled === true}
                            wrap="truncate-end"
                          >
                            {row.field || row.active === undefined ? '' : row.active ? '☑ ' : '☐ '}
                            {row.label}
                          </Text>
                          {directoryRows.has(index) ? (
                            <Box
                              ref={(element) => registerElement(directoryElements.current, index, element)}
                              paddingX={1}
                              flexShrink={0}
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
                            />
                          </Box>
                        ) : (
                          <Text
                            {...(row.descriptionColor ? { color: row.descriptionColor } : { dimColor: true })}
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
                      {...(actionHeight >= 3
                        ? {
                            borderStyle: 'single' as const,
                            borderColor: (active || interactiveHover) && (!primary || enabled) ? accent : undefined,
                            borderDimColor: !(active || interactiveHover) || (primary && !enabled),
                          }
                        : {})}
                    >
                      <Text
                        bold
                        {...(active || interactiveHover ? { color: accent } : {})}
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
        <Box height={navigationHeight} flexShrink={0} flexDirection="column" paddingX={1}>
          <Box justifyContent="center">
            <Text dimColor wrap="truncate-end">
              {navigationHints[0]}
            </Text>
          </Box>
          <Box height={1} alignItems="center">
            <Box flexGrow={1} justifyContent="center" overflow="hidden">
              <Text dimColor wrap="truncate-end">
                {navigationHints[1]}
              </Text>
            </Box>
            {settingsButton}
          </Box>
        </Box>
      ) : (
        <Box height={navigationHeight} flexShrink={0} alignItems="flex-end" paddingX={1}>
          <Box flexGrow={1} flexDirection="column" alignItems="center" overflow="hidden">
            {navigationHints.map((hint) => (
              <Text key={hint} dimColor wrap="truncate-end">
                {hint}
              </Text>
            ))}
          </Box>
          {settingsButton}
        </Box>
      )}
    </Box>
  )
}

function isProviderEnvironmentKey(value: EditableField): value is ProviderEnvironmentKey {
  return PROVIDER_ENVIRONMENT_KEYS.includes(value as ProviderEnvironmentKey)
}
