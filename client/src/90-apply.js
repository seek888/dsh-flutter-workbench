/* ====================================================================== *
 * 90-apply.js — owner: Lead
 * Slot registration: the `main` keyed panel and the sidebar icon.
 * ====================================================================== */

/** Sidebar cell icon: a terminal prompt with a reload arrow. */
function PanelIcon({ size = 16, active = false }) {
  const tint = active === true ? T.brand : T.textDim
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    'aria-hidden': true, style: { display: 'block' },
  },
    h('path', { d: 'M3 6l5 5-5 5', stroke: tint, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('path', { d: 'M12 16h8', stroke: tint, strokeWidth: 2, strokeLinecap: 'round' }),
    h('path', { d: 'M17 3l3 3-3 3', stroke: tint, strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

/** Client plugin body. Returns the exports the loader keeps for disposal. */
function apply(ctx) {
  const disposers = []

  // Dictionaries: the locale service re-renders labels through `label: () => t(...)`,
  // so a language switch needs no re-registration.
  try {
    if (typeof ctx?.locale?.register === 'function') {
      disposers.push(ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'flutter-workbench: dictionaries'))
    }
    const snapshot = ctx.get?.('locale')?.getSnapshot?.()
    if (snapshot !== undefined && snapshot !== null) setActiveLocale(snapshot.id)
  } catch (error) {
    console.error('[flutter-workbench] locale registration failed', error)
  }

  try {
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID, locale: LOCALE_NS,
    }, WorkbenchApp)))
  } catch (error) {
    console.error('[flutter-workbench] main slot registration failed', error)
  }

  try {
    disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => (currentLocale === 'en' ? 'Flutter workbench' : 'Flutter 工作台'),
      locale: LOCALE_NS,
    }, (owner = {}) => h(PanelIcon, { size: owner.size ?? 16, active: owner.active === true }))))
  } catch (error) {
    console.error('[flutter-workbench] sidebar.panellist registration failed', error)
  }

  return () => {
    // Clear the selection first: leaving the centre column pointing at a key
    // that no longer resolves renders an empty frame.
    try {
      const layout = ctx.get?.('layout')
      if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null)
    } catch {
      /* layout already gone */
    }
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
        else if (dispose !== undefined && typeof dispose.dispose === 'function') dispose.dispose()
      } catch {
        /* slot already gone */
      }
    }
  }
}

return { name: PANEL_ID, inject: ['slots', 'locale', 'layout'], apply }