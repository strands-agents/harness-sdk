function elementsWithin<T extends Element>(root: ParentNode, selector: string): T[] {
  const elements = Array.from(root.querySelectorAll<T>(selector))
  if (root instanceof Element && root.matches(selector)) elements.unshift(root as T)
  return elements
}

function rootWindow(root: ParentNode): Window & typeof globalThis {
  const document = root instanceof Document ? root : root.ownerDocument
  return (document?.defaultView ?? window) as Window & typeof globalThis
}

export function initializeTestimonialBrowsers(root: ParentNode = document): void {
  elementsWithin<HTMLElement>(root, '[data-testimonial-browser]').forEach((browser) => {
    if (browser.dataset.initialized === 'true') return

    const stories = Array.from(browser.querySelectorAll<HTMLElement>('[data-testimonial-story]'))
    const controls = browser.querySelector<HTMLElement>('[data-testimonial-controls]')
    const current = browser.querySelector<HTMLElement>('[data-testimonial-current]')
    const status = browser.querySelector<HTMLElement>('[data-testimonial-status]')
    const toggle = browser.querySelector<HTMLButtonElement>('[data-testimonial-toggle]')
    const previous = browser.querySelector<HTMLButtonElement>('[data-testimonial-previous]')
    const next = browser.querySelector<HTMLButtonElement>('[data-testimonial-next]')

    if (stories.length < 2 || !controls || !current || !status || !toggle || !previous || !next) return

    const currentElement: HTMLElement = current
    const statusElement: HTMLElement = status
    const toggleButton: HTMLButtonElement = toggle
    const browserWindow = rootWindow(browser)
    const browserDocument = browser.ownerDocument
    const interval = Number(browser.dataset.testimonialInterval) || 9000
    const reducedMotion = browserWindow.matchMedia?.('(prefers-reduced-motion: reduce)')
    const abortController = new AbortController()
    const listenerOptions = { signal: abortController.signal }
    let activeIndex = 0
    let rotationTimer: number | undefined
    let isVisible = false
    let isHovered = false
    let hasFocus = false
    let isPausedByUser = reducedMotion?.matches ?? false
    let observer: IntersectionObserver | undefined

    function showStory(index: number, announce = false): void {
      activeIndex = (index + stories.length) % stories.length
      stories.forEach((story, storyIndex) => {
        const isActive = storyIndex === activeIndex
        story.setAttribute('aria-hidden', isActive ? 'false' : 'true')
        story.inert = !isActive
      })
      currentElement.textContent = String(activeIndex + 1).padStart(2, '0')
      if (announce) statusElement.textContent = stories[activeIndex]?.getAttribute('aria-label') ?? ''
    }

    function updateToggle(): void {
      toggleButton.dataset.paused = String(isPausedByUser)
      toggleButton.setAttribute('aria-pressed', String(isPausedByUser))
      toggleButton.setAttribute(
        'aria-label',
        isPausedByUser ? 'Resume automatic story rotation' : 'Pause automatic story rotation'
      )
    }

    function stopRotation(): void {
      if (rotationTimer === undefined) return
      browserWindow.clearTimeout(rotationTimer)
      rotationTimer = undefined
    }

    function scheduleRotation(): void {
      stopRotation()
      if (isPausedByUser || !isVisible || isHovered || hasFocus || browserDocument.hidden) return
      rotationTimer = browserWindow.setTimeout(() => {
        showStory(activeIndex + 1)
        scheduleRotation()
      }, interval)
    }

    function showManualStory(index: number): void {
      showStory(index, true)
      scheduleRotation()
    }

    previous.addEventListener('click', () => showManualStory(activeIndex - 1), listenerOptions)
    next.addEventListener('click', () => showManualStory(activeIndex + 1), listenerOptions)
    toggleButton.addEventListener(
      'click',
      () => {
        isPausedByUser = !isPausedByUser
        updateToggle()
        scheduleRotation()
      },
      listenerOptions
    )
    browser.addEventListener(
      'mouseenter',
      () => {
        isHovered = true
        scheduleRotation()
      },
      listenerOptions
    )
    browser.addEventListener(
      'mouseleave',
      () => {
        isHovered = false
        scheduleRotation()
      },
      listenerOptions
    )
    browser.addEventListener(
      'focusin',
      () => {
        hasFocus = true
        scheduleRotation()
      },
      listenerOptions
    )
    browser.addEventListener(
      'focusout',
      () => {
        browserWindow.setTimeout(() => {
          hasFocus = browser.contains(browserDocument.activeElement)
          scheduleRotation()
        })
      },
      listenerOptions
    )
    browserDocument.addEventListener('visibilitychange', scheduleRotation, listenerOptions)
    reducedMotion?.addEventListener(
      'change',
      (event) => {
        isPausedByUser = event.matches
        updateToggle()
        scheduleRotation()
      },
      listenerOptions
    )

    if (typeof browserWindow.IntersectionObserver === 'function') {
      const intersectionObserver = new browserWindow.IntersectionObserver(
        ([entry]) => {
          isVisible = Boolean(entry && entry.intersectionRatio >= 0.35)
          scheduleRotation()
        },
        { threshold: 0.35 }
      )
      observer = intersectionObserver
      intersectionObserver.observe(browser)
    } else {
      isVisible = true
    }

    browserDocument.addEventListener(
      'astro:before-swap',
      () => {
        stopRotation()
        observer?.disconnect()
        abortController.abort()
      },
      { once: true, signal: abortController.signal }
    )

    browser.setAttribute('aria-roledescription', 'carousel')
    stories.forEach((story) => story.setAttribute('aria-roledescription', 'slide'))
    showStory(0)
    updateToggle()
    browser.dataset.initialized = 'true'
    controls.hidden = false
    scheduleRotation()
  })
}
