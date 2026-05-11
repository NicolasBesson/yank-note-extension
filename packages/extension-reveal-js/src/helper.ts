import { ctx, getExtensionBasePath } from '@yank-note/runtime-api'

const extensionId = __EXTENSION_ID__

const logger = ctx.utils.getLogger(extensionId)

export const i18n = ctx.i18n.createI18n({
  en: {
    present: 'Present with Reveal.js',
    print: 'Print with Reveal.js',
    fullscreen: 'Fullscreen',
    'reload-current': 'Reload (Keep Current Slide)',
  },
  'zh-CN': {
    present: '使用 Reveal.js 演示',
    print: '使用 Reveal.js 打印',
    fullscreen: '全屏',
    'reload-current': '重载 (保持当前页)',
  }
})

export function getOpts () {
  return ctx.view.getRenderEnv()?.attributes?.revealJsOpts || {}
}

export function getDraft (): boolean {
  return ctx.view.getRenderEnv()?.attributes?.draft === true
}

export function buildHTML (theme: string, init = true) {
  const baseUrl = getExtensionBasePath(extensionId)

  return `
        <link rel="stylesheet" href="${baseUrl}/dist/reset.css">
        <link rel="stylesheet" href="${baseUrl}/dist/reveal.css">
        <link rel="stylesheet" href="${baseUrl}/dist/theme/${theme}.css">
        <link rel="stylesheet" href="${baseUrl}/dist/plugin/highlight/monokai.css">

        <div class="reveal">
          <div id="reveal-slides" class="slides"></div>
        </div>

        <script src="${baseUrl}/dist/reveal.js"></script>
        <script src="${baseUrl}/dist/plugin/highlight/highlight.js"></script>
        <script src="${baseUrl}/dist/plugin/math/math.js"></script>
        ${init ? '<script> initReveal() </script>' : ''}
      `
}

export function getContentHtml (forExport = false) {
  return ctx.view.getContentHtml({
    useRemoteSrcOfLocalImage: !forExport,
    inlineLocalImage: forExport,
    includeStyle: true,
  })
}

export function getState (win: Window) {
  const Reveal = (win.window as any).Reveal
  return Reveal.getState()
}

export async function processReveal (win: Window, opts: Record<string, any>, contentHtml: string | Promise<string>, init: boolean, state?: any, draft = false) {
  const content = await contentHtml

  const tmp = document.createElement('div')
  tmp.innerHTML = content

  const slides = win.window.document.getElementById('reveal-slides')
  slides!.innerHTML = tmp.firstElementChild!.innerHTML!

  // markdown-it-container nesting limitation: a bare `:::` is the closing fence
  // for ALL container types, but each named rule (section, div, …) only counts
  // openers of its OWN type as nesting-incrementors. So `:::section` does NOT
  // count `:::div` openers — it closes on the FIRST bare `:::`, which is meant
  // to close an inner `:::div`. This leaves:
  //   • orphaned top-level <div> siblings of <section> in .slides
  //     (the inner divs that were cut off), and
  //   • orphaned bare `:::` fences (no opener left) rendered as <p>:::</p>.
  //
  // Fix in two passes:
  //  Pass 1 – re-attach orphaned elements to the preceding <section>.
  //    If the last child of that section is a .cols-2 div with < 2 columns,
  //    append the orphan as the missing column; otherwise append to the section.
  //  Pass 2 – remove any <p> whose sole text content is `:::` (markdown-it
  //    fall-through artefact from unmatched closing fences).
  let lastSection: Element | null = null
  for (const child of Array.from(slides!.children)) {
    if (child.tagName === 'SECTION') {
      lastSection = child
    } else if (lastSection) {
      const lastChild = lastSection.lastElementChild
      if (
        child.tagName === 'DIV' &&
        lastChild &&
        lastChild.tagName === 'DIV' &&
        lastChild.classList.contains('cols-2') &&
        lastChild.children.length < 2
      ) {
        lastChild.appendChild(child)
      } else {
        lastSection.appendChild(child)
      }
    }
  }

  // Pass 2: remove bare `:::` paragraph artefacts left by unmatched fences
  for (const p of Array.from(slides!.querySelectorAll('section > p'))) {
    if (p.textContent?.trim() === ':::') {
      p.remove()
    }
  }

  // Inject DRAFT stamp on every slide when draft mode is enabled
  if (draft) {
    for (const section of Array.from(slides!.querySelectorAll('section'))) {
      const stamp = win.window.document.createElement('div')
      stamp.className = 'draft-stamp'
      stamp.textContent = 'DRAFT'
      section.appendChild(stamp)
    }
  }

  const Reveal = (win.window as any).Reveal

  if (init) {
    const RevealHighlight = (win.window as any).RevealHighlight
    const RevealMath = (win.window as any).RevealMath
    await Reveal.initialize({
      hash: true,
      controls: true,
      center: true,
      ...opts,
      // Learn about plugins: https://revealjs.com/plugins/
      plugins: [RevealHighlight, RevealMath.KaTeX]
    })

    const style = win.window.document.createElement('style')
    style.id = 'reveal-custom-style'
    style.innerHTML = opts.customStyle || ''
    win.window.document.head.appendChild(style)

    if (state) {
      Reveal.slide(state.indexh, state.indexv, state.indexf)
    }
  } else {
    const state = Reveal.getState()
    Reveal.sync()
    Reveal.slide(state.indexh, state.indexv, state.indexf)
    const RevealHighlight = (win.window as any).RevealHighlight
    RevealHighlight().init({
      getConfig: () => Reveal.getConfig(),
      getRevealElement: () => Reveal.getRevealElement(),
      on: () => 0, // noop
    })

    const style = win.window.document.getElementById('reveal-custom-style')
    if (style) {
      style.innerHTML = opts.customStyle || ''
    }
  }
}

export async function present (print = false) {
  // if (!ctx.getPremium()) {
  //   ctx.ui.useToast().show('info', ctx.i18n.t('premium.need-purchase', extensionId))
  //   ctx.showPremium()
  //   throw new Error('Extension requires premium')
  // }

  const htmlTitle = ctx.store.state.currentFile?.name || 'Reveal.js'
  const opts = getOpts()
  const draft = getDraft()
  const theme = opts.theme || 'black'

  const html = buildHTML(theme)

  const url = new URL(location.origin + ctx.embed.buildSrc(html, htmlTitle))
  if (print) {
    url.searchParams.set('print-pdf', 'true')
  }

  const fileUri = ctx.doc.toUri(ctx.store.state.currentFile)

  const contentPromise = getContentHtml(print)

  const win = ctx.env.openWindow(url.toString(), '_blank', { alwaysOnTop: false })
  if (!win) {
    throw new Error('Failed to open window')
  }

  (win.window as any).initReveal = async () => {
    processReveal(win, opts, contentPromise, true, undefined, draft)

    if (print) {
      setTimeout(() => win.window.print(), 1500)
    }
  }

  (win.window as any).updateReveal = async (contentHtml: string) => {
    processReveal(win, opts, contentHtml, false, undefined, draft)

    if (print) {
      setTimeout(() => win.window.print(), 1500)
    }
  }

  const refreshContent = async ({ doc }) => {
    if (!win || !win.window) {
      logger.debug('remove hook')
      ctx.removeHook('DOC_SAVED', refreshContent)
      return
    }

    if (ctx.doc.toUri(doc) === fileUri) {
      logger.debug('refresh content', fileUri)
      ;(win.window as any).updateReveal(await getContentHtml())
    }
  }

  ctx.registerHook('DOC_SAVED', refreshContent)
}
