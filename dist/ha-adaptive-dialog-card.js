/**
 * HA Adaptive Dialog Card
 * ========================
 * v2.3.0
 *
 * Opens an ha-adaptive-dialog popup when the URL hash matches the configured value.
 * Uses the native HA dialog component for responsive layout, animations, and
 * mobile bottom-sheet behavior.
 *
 * Config options:
 *   type: custom:ha-adaptive-dialog-card
 *   hash: "#popup1"            # URL hash that opens this popup (# prefix optional)
 *   title: ""                  # optional dialog title; supports Jinja2 templates
 *   subtitle: ""               # optional subtitle shown below the title; supports Jinja2 templates
 *   icon: ""                   # optional MDI icon shown left of title/subtitle
 *   header_badge:              # optional badge shown in the header action area
 *   width_desktop: "medium"    # Desktop width: small|medium|large|full or CSS value
 *   width_mobile:  "medium"    # Mobile width: small|medium|large or CSS value
 *   min_height_desktop: ""     # Optional min-height for desktop (e.g. 300px, 50vh)
 *   min_height_mobile:  ""     # Optional min-height for mobile (e.g. 200px, 30vh)
 *   prevent_close: false       # if true, backdrop click / Escape does not close
 *   close_position: "left"     # position of X button: left|right|hidden
 *   allow_mode_change: true    # header click expands dialog; viewport layout changes applied
 *   card:                      # any HA card config to render inside the popup
 *
 * Opening a popup from another card:
 *   tap_action:
 *     action: navigate
 *     navigation_path: "#popup1"
 */

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

const VERSION = '1.0.0';

const { t } = await import(`./i18n/index.js?v=${VERSION}`);
const CARD_TYPE = 'custom:ha-adaptive-dialog-card';
const CARD_TAG = 'ha-adaptive-dialog-card';
const EDITOR_TAG = 'ha-adaptive-dialog-card-editor';
const REGISTRY_KEY = '__haAdaptiveDialogCards';

const WIDTH_PRESETS = new Set(['small', 'medium', 'large', 'full']);
const MOBILE_WIDTH_PX = { small: '320px', medium: '580px', large: '1024px' };
const CLOSE_ICON_PATH = 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z';
const VALID_CLOSE_POSITIONS = ['left', 'right', 'hidden'];

// ══════════════════════════════════════════════════════════════════════════════
// Utility functions
// ══════════════════════════════════════════════════════════════════════════════

/** Walk up the composed DOM tree, crossing shadow boundaries. */
function* composedAncestors(el) {
  let cur = el;
  while (cur) {
    const parent = cur.parentNode;
    if (parent instanceof ShadowRoot) cur = parent.host;
    else if (parent) cur = parent;
    else break;
    yield cur;
  }
}

/** Get the home-assistant root element. */
function getHaRoot() {
  return document.querySelector('home-assistant');
}

/** Get current hass object from the DOM. */
function getHass() {
  return getHaRoot()?.hass ?? null;
}

/**
 * Create a HA card element from a config object.
 * Prefers direct creation if the custom element is registered, falls back
 * to hui-card for lazy-loaded HA built-in card types.
 */
function buildCardElement(cardConfig, hass) {
  if (!cardConfig?.type) return null;
  const tag = cardConfig.type.startsWith('custom:')
    ? cardConfig.type.slice(7)
    : `hui-${cardConfig.type}-card`;

  // Direct creation if element is registered
  if (customElements.get(tag)) {
    const el = document.createElement(tag);
    try { if (typeof el.setConfig === 'function') el.setConfig(cardConfig); } catch (_) {}
    if (hass) el.hass = hass;
    return el;
  }
  // Lazy-load via hui-card wrapper
  if (customElements.get('hui-card')) {
    const el = document.createElement('hui-card');
    try { el.config = cardConfig; } catch (_) {}
    if (hass) el.hass = hass;
    return el;
  }
  // Last resort
  let el;
  try { el = document.createElement(tag); } catch (e) {
    console.error(`[${CARD_TAG}] Cannot create <${tag}>:`, e);
    return null;
  }
  try { if (typeof el.setConfig === 'function') el.setConfig(cardConfig); } catch (_) {}
  if (hass) el.hass = hass;
  return el;
}

/** Create a HA badge element (uses hui-badge host + .config/.load API). */
function buildBadgeElement(badgeConfig, hass) {
  if (!badgeConfig?.type) return null;
  const el = document.createElement('hui-badge');
  try { el.config = badgeConfig; } catch (_) {}
  if (hass) el.hass = hass;
  try { if (typeof el.load === 'function') el.load(); } catch (_) {}
  return el;
}

/** Check if a string contains Jinja2 template syntax. */
function isTemplate(str) {
  return typeof str === 'string' && (str.includes('{{') || str.includes('{%'));
}

/**
 * Extract a template render result or error message from a WS subscription message.
 * Returns { text, isError }.
 */
function parseTemplateMessage(msg) {
  if (msg.error) {
    const err = msg.error;
    const text = typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : String(err);
    return { text: `Template error: ${text}`, isError: true };
  }
  return { text: msg.result ?? '', isError: false };
}

// ══════════════════════════════════════════════════════════════════════════════
// Lovelace config helpers
// ══════════════════════════════════════════════════════════════════════════════

/** Get the current Lovelace config by walking HA's shadow DOM. */
function getLovelaceConfig() {
  try {
    return getHaRoot()
      ?.shadowRoot?.querySelector('home-assistant-main')
      ?.shadowRoot?.querySelector('partial-panel-resolver')
      ?.querySelector('ha-panel-lovelace')
      ?.shadowRoot?.querySelector('hui-root')
      ?.lovelace?.config;
  } catch (_) { return null; }
}

/** Recursively collect all ha-adaptive-dialog-card configs from a card tree. */
function findPopupConfigs(cards) {
  const result = [];
  for (const card of (cards ?? [])) {
    if (card?.type === CARD_TYPE && card.hash) result.push(card);
    if (card?.cards) result.push(...findPopupConfigs(card.cards));
    if (card?.card)  result.push(...findPopupConfigs([card.card]));
  }
  return result;
}

/** Normalize a hash string to always include the # prefix. */
function normalizeHash(hash) {
  const h = String(hash);
  return h.startsWith('#') ? h : '#' + h;
}

/**
 * Scan the Lovelace config for all popup card definitions and pre-register
 * any that are not yet in the registry. Skips if config hasn't changed.
 */
function scanLovelaceForPopups() {
  const config = getLovelaceConfig();
  if (!config || config === _registry._lastConfig) return;
  _registry._lastConfig = config;

  const hass = getHass() ?? _registry._latestHass;

  for (const view of (config.views ?? [])) {
    const cards = [...(view.cards ?? [])];
    for (const section of (view.sections ?? [])) cards.push(...(section.cards ?? []));

    for (const cfg of findPopupConfigs(cards)) {
      const hash = normalizeHash(cfg.hash);
      if (_registry.has(hash)) continue;
      // Create a detached instance to hold config and respond to hash changes
      const inst = new AdaptiveDialogCard();
      inst.setConfig(cfg);
      if (hass) inst._hass = hass;
      inst._hashOnConnect = (location.hash === inst._config?.hash);
      inst._syncWithHash();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Global popup registry (singleton, survives hot-reloads)
// ══════════════════════════════════════════════════════════════════════════════

const _registry = (() => {
  const existing = window[REGISTRY_KEY];
  if (existing) {
    // Ensure properties added in newer versions are present
    existing._latestHass   ??= null;
    existing._lastConfig   ??= null;
    existing._openDetached ??= null;
    return existing;
  }

  const registry = new Map();
  registry._latestHass   = null;
  registry._lastConfig   = null;
  registry._openDetached = null;

  // ── Hash change listeners ──────────────────────────────────────────────
  const onHashChange = () => {
    scanLovelaceForPopups();
    for (const card of registry.values()) card._syncWithHash();
  };
  window.addEventListener('location-changed', onHashChange);
  window.addEventListener('popstate',         onHashChange);
  window.addEventListener('hashchange',       onHashChange);

  // ── Direct URL load with hash ──────────────────────────────────────────
  // Poll until the target popup opens or 10s have passed.
  const initHash = location.hash;
  if (initHash) {
    let done = false;
    const poll = setInterval(() => {
      if (done) { clearInterval(poll); return; }
      if (location.hash !== initHash)    { done = true; clearInterval(poll); return; }
      if (!registry._latestHass) {
        const h = getHass();
        if (h) registry._latestHass = h; else return;
      }
      scanLovelaceForPopups();
      for (const card of registry.values()) card._syncWithHash();
      if (registry.get(initHash)?._isOpen)            { done = true; clearInterval(poll); return; }
      if (getLovelaceConfig() && !registry.has(initHash)) { done = true; clearInterval(poll); }
    }, 100);
    setTimeout(() => { done = true; clearInterval(poll); }, 10000);
  }

  // ── Hass forwarding for detached (cross-view) popups ───────────────────
  setInterval(() => {
    const od = registry._openDetached;
    if (!od?._isOpen) return;
    const h = getHass();
    if (!h || h === od._hass) return;
    od._hass = h;
    registry._latestHass = h;
    if (od._cardEl)        od._cardEl.hass        = h;
    if (od._headerBadgeEl) od._headerBadgeEl.hass = h;
  }, 500);

  window[REGISTRY_KEY] = registry;
  return registry;
})();

// ══════════════════════════════════════════════════════════════════════════════
// LitElement base class from HA bundle
// ══════════════════════════════════════════════════════════════════════════════

const LitElement = Object.getPrototypeOf(customElements.get('ha-panel-lovelace'));
const { html, css } = LitElement.prototype;

// ══════════════════════════════════════════════════════════════════════════════
// Stylesheets (parsed once, shared across all instances)
// ══════════════════════════════════════════════════════════════════════════════

const PREVIEW_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .header {
    display: flex; align-items: center; min-height: 56px;
    padding: var(--ha-space-3, 24px) var(--ha-space-6, 24px) var(--ha-space-3, 12px) var(--ha-space-6, 24px);
    flex-shrink: 0; gap: 4px;
  }
  .header.close-hidden .close-btn { display: none; }
  .header.close-right { justify-content: flex-end; }
  .header.close-right .close-btn { order: 1; }

  .title-icon {
    --mdc-icon-size: 24px; flex-shrink: 0;
    color: var(--ha-dialog-header-title-color, var(--primary-text-color, #212121));
  }

  .close-btn {
    display: flex; align-items: center; width: auto; height: 40px;
    flex-shrink: 0; border-radius: 50%; padding: 0; opacity: 0.4;
    color: var(--primary-text-color, #212121); justify-content: flex-start;
  }
  .close-btn ha-icon { --mdc-icon-size: 24px; display: block; pointer-events: none; }

  .title {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
    font-size: var(--ha-dialog-header-title-font-size, var(--ha-font-size-2xl, 1.714286rem));
    font-weight: var(--ha-dialog-header-title-font-weight, var(--ha-font-weight-normal, 400));
    line-height: var(--ha-dialog-header-title-line-height, var(--ha-line-height-condensed, 1.2));
    color: var(--ha-dialog-header-title-color, var(--primary-text-color, #212121));
  }

  .subtitle {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -2px;
    font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
    font-size: var(--ha-font-size-s, 0.857rem);
    color: var(--secondary-text-color, #727272);
  }

  .title-group { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .header-badge-slot { flex-shrink: 0; display: flex; align-items: center; }
  .header-badge-slot > * {
    --ha-card-box-shadow: none; --ha-card-border-radius: 0; --ha-card-border-width: 0;
  }
  .hidden { display: none; }
`;

const CARD_CSS = `
  :host { display: block; height: 0; overflow: visible; pointer-events: none; }
  :host([data-mode="dashboard-edit"]),
  :host([data-mode="card-editor"]) {
    height: auto; overflow: hidden; pointer-events: auto;
  }

  .placeholder {
    display: flex; align-items: center; gap: 8px; padding: 12px 16px;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border: 2px dashed var(--divider-color, rgba(0,0,0,.2));
    border-radius: var(--ha-card-border-radius, 12px);
    color: var(--secondary-text-color, #727272);
    font-family: var(--mdc-typography-body2-font-family, Roboto, sans-serif);
    font-size: var(--mdc-typography-body2-font-size, 13px);
  }
  .placeholder ha-icon { --mdc-icon-size: 16px; flex-shrink: 0; }
  .placeholder code {
    background: rgba(0,0,0,.07); padding: 1px 5px; border-radius: 4px; font-size: 11px;
  }
  .placeholder.duplicate { border-color: var(--error-color, #db4437); }
  .placeholder .warning-icon {
    --mdc-icon-size: 16px; flex-shrink: 0;
    color: var(--error-color, #db4437); margin-left: auto;
  }

  .preview {
    display: flex; flex-direction: column; min-width: 280px; width: 100%;
    max-height: 60vh;
    border-radius: var(--ha-dialog-border-radius, var(--ha-border-radius-3xl, 24px));
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); overflow: hidden;
    background: var(--ha-dialog-surface-background, var(--card-background-color, var(--ha-color-surface-default, #fff)));
    box-shadow: var(--dialog-box-shadow, var(--wa-shadow-l, 0 8px 40px rgba(0,0,0,.2)));
  }

  .preview-content {
    flex: 1; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
    padding: 0 var(--ha-space-6, 24px) var(--ha-space-6, 24px) var(--ha-space-6, 24px);
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb-color, rgba(0,0,0,.3)) transparent;
  }
  .preview-content::-webkit-scrollbar       { width: 6px; }
  .preview-content::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb-color, rgba(0,0,0,.3)); border-radius: 3px; }
  .preview-content::-webkit-scrollbar-track { background: transparent; }

  .preview-empty {
    color: var(--secondary-text-color, #727272);
    font-size: var(--ha-font-size-s, 0.857rem);
    font-style: italic;
    font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
  }

  ${PREVIEW_CSS}
`;

const EDITOR_CSS = `
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
    margin-bottom: 16px;
  }
  .tab {
    flex: 1; padding: 10px 4px; background: none; border: none; cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    font-family: var(--mdc-typography-button-font-family, Roboto, sans-serif);
    font-size: var(--mdc-typography-button-font-size, 13px);
    font-weight: var(--mdc-typography-button-font-weight, 500);
    color: var(--secondary-text-color, #727272);
    transition: color 150ms, border-color 150ms;
    text-transform: var(--mdc-typography-button-text-transform, uppercase);
    letter-spacing: var(--mdc-typography-button-letter-spacing, 0.0892857143em);
    -webkit-tap-highlight-color: transparent;
  }
  .tab.active {
    color: var(--primary-color, #03a9f4);
    border-bottom-color: var(--primary-color, #03a9f4);
  }
  .tab-panel        { display: none; }
  .tab-panel.active { display: block; }
  .change-bar       { display: flex; justify-content: flex-end; margin-bottom: 8px; }
  ha-alert          { display: block; margin-bottom: 16px; }
`;

// CSSStyleSheet singletons — parsed once at first use
let _cardSheet = null;
let _editorSheet = null;
const getCardSheet = () => {
  if (!_cardSheet) { _cardSheet = new CSSStyleSheet(); _cardSheet.replaceSync(CARD_CSS); }
  return _cardSheet;
};
const getEditorSheet = () => {
  if (!_editorSheet) { _editorSheet = new CSSStyleSheet(); _editorSheet.replaceSync(EDITOR_CSS); }
  return _editorSheet;
};

// ══════════════════════════════════════════════════════════════════════════════
// Shadow DOM traversal helpers for ha-adaptive-dialog internals
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the inner dialog element and body from ha-adaptive-dialog.
 * Works for both desktop (ha-dialog → wa-dialog) and mobile (ha-bottom-sheet → wa-drawer).
 * Returns { dialogEl, body, waRoot } or null.
 */
function resolveDialogInternals(adaptiveDialog) {
  const sr = adaptiveDialog?.shadowRoot;
  if (!sr) return null;

  // Desktop: ha-dialog → wa-dialog → <dialog>
  const haDialog = sr.querySelector('ha-dialog');
  if (haDialog) {
    const waDialog = haDialog.shadowRoot?.querySelector('wa-dialog');
    const dialogEl = waDialog?.shadowRoot?.querySelector('dialog');
    const body = haDialog.shadowRoot?.querySelector('.content-wrapper .body');
    if (dialogEl && body) return { dialogEl, body, waRoot: waDialog.shadowRoot, haDialog };
  }

  // Mobile: ha-bottom-sheet → wa-drawer → <dialog>
  const bs = sr.querySelector('ha-bottom-sheet');
  if (bs) {
    const waDrawer = bs.shadowRoot?.querySelector('wa-drawer');
    const dialogEl = waDrawer?.shadowRoot?.querySelector('dialog');
    const body = bs.shadowRoot?.querySelector('.body');
    if (dialogEl && body) return { dialogEl, body, waRoot: waDrawer.shadowRoot, bs };
  }

  return null;
}

/**
 * Retry a callback until it returns true, with a maximum number of attempts.
 * Uses setTimeout for non-blocking retries.
 */
function retryUntil(fn, { interval = 50, maxAttempts = 20 } = {}) {
  let attempt = 0;
  const tryOnce = () => {
    if (attempt++ >= maxAttempts) return;
    if (!fn()) setTimeout(tryOnce, interval);
  };
  requestAnimationFrame(() => requestAnimationFrame(tryOnce));
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Card
// ══════════════════════════════════════════════════════════════════════════════

class AdaptiveDialogCard extends LitElement {

  // ── LitElement boilerplate ──────────────────────────────────────────────

  static get properties() {
    return {
      _config:   { state: true },
      _lastMode: { state: true },
    };
  }

  static get styles() { return getCardSheet(); }

  static getStubConfig() {
    return {
      hash: '#popup1', title: '', width_desktop: 'medium',
      prevent_close: false, card: { type: 'markdown', content: 'Hello from Popup!' },
    };
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  constructor() {
    super();
    this._config  = null;
    this._hass    = null;
    this._dialog  = null;

    // Child elements inserted into the popup
    this._cardEl        = null;
    this._headerBadgeEl = null;

    // Child elements inserted into the editor preview
    this._previewCardEl        = null;
    this._previewHeaderBadgeEl = null;

    // Popup state
    this._isOpen  = false;
    this._closing = false;
    this._lastMode      = 'normal'; // 'normal' | 'dashboard-edit' | 'card-editor'
    this._navigatedToHash = false;
    this._hashOnConnect   = false;

    // Subscriptions & observers
    this._titleUnsubscribe        = null;
    this._subtitleUnsubscribe     = null;
    this._previewTitleUnsubscribe = null;
    this._resizeObserver          = null;
    this._modeObserver            = null;
  }

  // ── Config ──────────────────────────────────────────────────────────────

  setConfig(config) {
    if (!config?.hash) throw new Error(`[${CARD_TAG}] "hash" is required`);
    const oldHash = this._config?.hash;
    this._config = {
      hash:             normalizeHash(config.hash),
      title:            config.title            ?? '',
      subtitle:         config.subtitle         ?? '',
      icon:             config.icon             ?? '',
      width_desktop:      config.width_desktop      || config.width || 'medium',
      width_mobile:       config.width_mobile       || config.width || 'medium',
      min_height_desktop: config.min_height_desktop ?? '',
      min_height_mobile:  config.min_height_mobile  ?? '',
      prevent_close:      config.prevent_close      ?? false,
      close_position:     VALID_CLOSE_POSITIONS.includes(config.close_position) ? config.close_position : 'left',
      allow_mode_change:  config.allow_mode_change  ?? true,
      card:               config.card               ?? null,
      header_badge:       config.header_badge       ?? null,
    };
    // Keep global registry up-to-date
    if (oldHash && oldHash !== this._config.hash && _registry.get(oldHash) === this) {
      _registry.delete(oldHash);
    }
    _registry.set(this._config.hash, this);
  }

  // ── Hass ────────────────────────────────────────────────────────────────

  set hass(hass) {
    const isFirst = !this._hass;
    this._hass = hass;
    _registry._latestHass = hass;

    // Forward to popup children
    this._forwardHass(hass, this._cardEl, this._headerBadgeEl);
    // Forward to preview children
    this._forwardHass(hass, this._previewCardEl, this._previewHeaderBadgeEl);
    // Forward to detached popup (cross-view)
    const od = _registry._openDetached;
    if (od && od !== this && od._isOpen) {
      od._hass = hass;
      this._forwardHass(hass, od._cardEl, od._headerBadgeEl);
    }

    scanLovelaceForPopups();
    this._updateEditMode();
    if (isFirst) this._syncWithHash();
  }

  _forwardHass(hass, ...elements) {
    for (const el of elements) { if (el) el.hass = hass; }
  }

  // ── Card API ────────────────────────────────────────────────────────────

  getCardSize() { return 0; }

  getGridOptions() {
    return { rows: 'auto', columns: 'full', min_rows: 'auto', max_rows: 'auto', min_columns: 12, max_columns: 12 };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    if (_registry._openDetached === this) _registry._openDetached = null;
    this._hashOnConnect = (location.hash === this._config?.hash);
    setTimeout(() => this._syncWithHash(), 50);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._isOpen) _registry._openDetached = this;
  }

  // ── LitElement rendering ────────────────────────────────────────────────

  render() {
    if (!this._config) return html``;
    switch (this._lastMode) {
      case 'card-editor':    return this._renderPreview();
      case 'dashboard-edit': return this._renderPlaceholder();
      default:               return html``;
    }
  }

  _renderPreview() {
    const { title = '', subtitle = '', icon, header_badge, close_position: closePos = 'left' } = this._config;
    const hasTitle    = !!title;
    const hasSubtitle = !!subtitle;
    const hasIcon     = !!icon;
    const hasBadge    = !!header_badge;
    const titleIsTPL  = hasTitle && isTemplate(title);

    const closeBtn = closePos !== 'hidden'
      ? html`<div class="close-btn" aria-hidden="true"><ha-icon icon="mdi:window-close"></ha-icon></div>`
      : '';

    return html`
      <div class="preview">
        <div class="header close-${closePos}">
          ${closePos === 'left' ? closeBtn : ''}
          ${hasIcon ? html`<ha-icon class="title-icon" icon="${icon}"></ha-icon>` : ''}
          <div class="title-group">
            ${hasTitle
              ? titleIsTPL
                ? html`<span class="title" id="preview-title"></span>`
                : html`<span class="title">${title}</span>`
              : ''}
            ${hasSubtitle ? html`<span class="subtitle">${subtitle}</span>` : ''}
          </div>
          ${hasBadge ? html`<div class="header-badge-slot" id="preview-header-badge-slot"></div>` : ''}
          ${closePos === 'right' ? closeBtn : ''}
        </div>
        <div class="preview-content" id="preview-content"
             style="${this._config.min_height_desktop ? `min-height:${this._config.min_height_desktop}` : ''}">
          ${!this._config.card ? html`<div class="preview-empty">${t(this._hass, 'No card configured')}</div>` : ''}
        </div>
      </div>
    `;
  }

  _renderPlaceholder() {
    const isDuplicate = this._countHashInConfig(this._config.hash) > 1;
    return html`
      <div class="placeholder ${isDuplicate ? 'duplicate' : ''}">
        <ha-icon icon="mdi:card-multiple-outline"></ha-icon>
        Popup <code>${this._config.hash}</code>
        ${isDuplicate ? html`<ha-icon class="warning-icon" icon="mdi:alert" title="${t(this._hass, 'This hash is used multiple times')}"></ha-icon>` : ''}
      </div>
    `;
  }

  willUpdate(changedProps) {
    if (changedProps.has('_lastMode')) this.setAttribute('data-mode', this._lastMode);
  }

  updated(changedProps) {
    if (this._lastMode === 'card-editor' && (changedProps.has('_lastMode') || changedProps.has('_config'))) {
      this._setupPreviewChildren();
    }
    if (changedProps.get('_lastMode') === 'card-editor' && this._lastMode !== 'card-editor') {
      this._cleanupPreviewChildren();
    }
  }

  // ── Preview children (card-editor mode) ─────────────────────────────────

  _setupPreviewChildren() {
    this._cleanupPreviewChildren();

    if (this._config.card) {
      const slot = this.shadowRoot.getElementById('preview-content');
      if (slot) this._insertCardElement(slot, this._config.card, '_previewCardEl', () => !!this.shadowRoot?.getElementById('preview-content'));
    }
    if (this._config.header_badge) {
      const slot = this.shadowRoot.getElementById('preview-header-badge-slot');
      if (slot) this._insertBadgeElement(slot, this._config.header_badge, '_previewHeaderBadgeEl', () => !!this.shadowRoot?.getElementById('preview-header-badge-slot'));
    }
    if (this._config.title && isTemplate(this._config.title)) {
      this._subscribePreviewTitleTemplate();
    }
  }

  _cleanupPreviewChildren() {
    this._cancelSubscription('_previewTitleUnsubscribe');
    this._previewCardEl?.remove();
    this._previewHeaderBadgeEl?.remove();
    this._previewCardEl = null;
    this._previewHeaderBadgeEl = null;
  }

  // ── Mode detection ──────────────────────────────────────────────────────

  _updateEditMode() {
    const mode = this._detectMode();
    if (mode !== this._lastMode) this._lastMode = mode;
  }

  _detectMode() {
    let dashEdit = false;
    for (const el of composedAncestors(this)) {
      const tag = el.tagName?.toLowerCase() ?? '';
      if (tag === 'ha-dialog') return 'card-editor';
      if (tag === 'hui-card-options' || el.classList?.contains('edit-mode')) dashEdit = true;
      if (tag === 'hui-root' && (el.editMode || el.lovelace?.editMode)) dashEdit = true;
    }
    try {
      const huiRoot = getHaRoot()
        ?.shadowRoot?.querySelector('home-assistant-main')
        ?.shadowRoot?.querySelector('partial-panel-resolver')
        ?.querySelector('ha-panel-lovelace')
        ?.shadowRoot?.querySelector('hui-root');
      if (huiRoot?.lovelace?.editMode || huiRoot?.editMode) dashEdit = true;
    } catch (_) {}
    return dashEdit ? 'dashboard-edit' : 'normal';
  }

  // ── Duplicate hash detection ────────────────────────────────────────────

  _countHashInConfig(hash) {
    if (!hash) return 0;
    const config = getLovelaceConfig();
    if (!config) return 0;
    let count = 0;
    for (const view of (config.views ?? [])) {
      const cards = [...(view.cards ?? [])];
      for (const section of (view.sections ?? [])) cards.push(...(section.cards ?? []));
      for (const cfg of findPopupConfigs(cards)) {
        if (normalizeHash(cfg.hash) === hash) count++;
      }
    }
    return count;
  }

  // ── Element insertion ───────────────────────────────────────────────────

  _insertCardElement(container, cardConfig, prop, guard) {
    const tag = cardConfig.type?.startsWith('custom:')
      ? cardConfig.type.slice(7) : `hui-${cardConfig.type}-card`;
    const doInsert = () => {
      if (!guard()) return;
      const el = buildCardElement(cardConfig, this._hass);
      if (el) { container.appendChild(el); this[prop] = el; }
    };
    (customElements.get(tag) || customElements.get('hui-card'))
      ? doInsert()
      : customElements.whenDefined(tag).then(doInsert);
  }

  _insertBadgeElement(container, badgeConfig, prop, guard) {
    const doInsert = () => {
      if (!guard()) return;
      const el = buildBadgeElement(badgeConfig, this._hass);
      if (el) { container.appendChild(el); this[prop] = el; }
    };
    customElements.get('hui-badge') ? doInsert() : customElements.whenDefined('hui-badge').then(doInsert);
  }

  // ── Template subscriptions ──────────────────────────────────────────────

  _cancelSubscription(prop) {
    if (this[prop]) {
      try { this[prop](); } catch (_) {}
      this[prop] = null;
    }
  }

  async _subscribeTemplate(template, onResult, unsubProp, guard) {
    this._cancelSubscription(unsubProp);
    if (!this._hass?.connection) return;
    try {
      this[unsubProp] = await this._hass.connection.subscribeMessage(
        onResult,
        { type: 'render_template', template },
      );
      if (!guard()) this._cancelSubscription(unsubProp);
    } catch (e) {
      console.error(`[${CARD_TAG}] Template error:`, e);
    }
  }

  _subscribeTitleTemplate() {
    const hasIcon = !!this._config.icon;
    this._subscribeTemplate(
      this._config.title,
      (msg) => {
        if (!this._dialog) return;
        const { text } = parseTemplateMessage(msg);
        if (hasIcon) {
          const span = this._dialog.querySelector('#popup-title');
          if (span) span.textContent = text;
        } else {
          this._dialog.headerTitle = text;
        }
      },
      '_titleUnsubscribe',
      () => !!this._dialog,
    );
  }

  _subscribeSubtitleTemplate() {
    this._subscribeTemplate(
      this._config.subtitle,
      (msg) => {
        if (!this._dialog) return;
        const { text } = parseTemplateMessage(msg);
        this._dialog.headerSubtitle = text;
      },
      '_subtitleUnsubscribe',
      () => !!this._dialog,
    );
  }

  _subscribePreviewTitleTemplate() {
    this._subscribeTemplate(
      this._config.title,
      (msg) => {
        const el = this.shadowRoot?.getElementById('preview-title');
        if (!el) return;
        const { text, isError } = parseTemplateMessage(msg);
        if (isError) {
          el.classList.add('hidden');
          let w = this.shadowRoot.getElementById('preview-title-warning');
          if (!w) { w = document.createElement('hui-warning'); w.id = 'preview-title-warning'; el.insertAdjacentElement('afterend', w); }
          w.textContent = text;
        } else {
          el.classList.remove('hidden');
          el.textContent = text;
          this.shadowRoot.getElementById('preview-title-warning')?.remove();
        }
      },
      '_previewTitleUnsubscribe',
      () => !!this.shadowRoot?.getElementById('preview-title'),
    );
  }

  // ── Hash sync ───────────────────────────────────────────────────────────

  _syncWithHash() {
    if (this._lastMode !== 'normal' || !this._config?.hash) return;
    const shouldBeOpen = location.hash === this._config.hash;
    if (shouldBeOpen && !this._isOpen && !this._closing) {
      this._navigatedToHash = !this._hashOnConnect;
      this._hashOnConnect = false;
      this._openPopup();
    } else if (!shouldBeOpen && this._isOpen && !this._closing) {
      this._closePopup(false);
    }
  }

  _removeHash() {
    if (location.hash !== this._config?.hash) return;
    if (this._navigatedToHash) {
      history.back();
    } else {
      history.replaceState(null, '', window.location.href.split('#')[0]);
      window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: true } }));
    }
  }

  // ── Open popup ──────────────────────────────────────────────────────────

  _openPopup() {
    if (this._isOpen) return;

    // Ensure freshest hass
    const freshHass = _registry._latestHass || getHass();
    if (freshHass) { this._hass = freshHass; _registry._latestHass = freshHass; }
    if (!this._hass) return;

    this._isOpen  = true;
    this._closing = false;
    if (!this.isConnected) _registry._openDetached = this;

    const cfg = this._config;
    const hasTitle    = !!cfg.title;
    const hasSubtitle = !!cfg.subtitle;
    const hasIcon     = !!cfg.icon;
    const hasBadge    = !!cfg.header_badge;
    const titleIsTPL    = hasTitle && isTemplate(cfg.title);
    const subtitleIsTPL = hasSubtitle && isTemplate(cfg.subtitle);

    // ── Create dialog ──
    const dialog = document.createElement('ha-adaptive-dialog');
    dialog.hass = this._hass;
    this._dialog = dialog;

    // ── Header: title / subtitle / icon ──
    this._setupDialogHeader(dialog, cfg, hasTitle, hasSubtitle, hasIcon, titleIsTPL, subtitleIsTPL);

    // ── Width ──
    this._applyWidth(dialog, cfg);

    // ── Behavioral attributes ──
    if (cfg.prevent_close) {
      dialog.setAttribute('prevent-scrim-close', '');
      dialog.addEventListener('cancel', (e) => e.preventDefault());
    }
    dialog.style.setProperty('--dialog-content-padding', '0 var(--ha-space-2) var(--ha-space-6) var(--ha-space-2)');
    dialog.setAttribute('flexcontent', '');

    if (cfg.allow_mode_change) {
      dialog.setAttribute('allow-mode-change', '');
    }

    // ── Close button position ──
    this._setupCloseButton(dialog, cfg.close_position);

    // ── Header badge (right-aligned in header action area) ──
    if (hasBadge) {
      const wrapper = document.createElement('div');
      wrapper.slot = 'headerActionItems';
      wrapper.style.cssText = 'display:flex;align-items:center;--ha-card-box-shadow:none;--ha-card-border-radius:0;--ha-card-border-width:0;';
      this._insertBadgeElement(wrapper, cfg.header_badge, '_headerBadgeEl', () => !!this._dialog);
      dialog.appendChild(wrapper);
    }

    // ── Close button right (after badge = rightmost) ──
    if (cfg.close_position === 'right') {
      const closeBtn = document.createElement('ha-icon-button');
      closeBtn.slot = 'headerActionItems';
      closeBtn.label = t(this._hass, 'Close');
      closeBtn.path = CLOSE_ICON_PATH;
      closeBtn.addEventListener('click', () => this._closePopup(true));
      dialog.appendChild(closeBtn);
    }

    // ── Main card content ──
    if (cfg.card) {
      const contentDiv = document.createElement('div');
      this._insertCardElement(contentDiv, cfg.card, '_cardEl', () => !!this._dialog);
      dialog.appendChild(contentDiv);
    }

    // ── Mount & open ──
    const haRoot = getHaRoot();
    (haRoot?.shadowRoot ?? document.body).appendChild(dialog);
    dialog.open = true;

    // ── Post-open setup (deferred until shadow DOM is ready) ──
    this._setupPostOpen(dialog, cfg);

    // ── Template subscriptions ──
    if (hasTitle && titleIsTPL)       this._subscribeTitleTemplate();
    if (hasSubtitle && subtitleIsTPL) this._subscribeSubtitleTemplate();

    // ── Close handlers ──
    const onClosed = () => {
      dialog.removeEventListener('closed', onClosed);
      dialog.removeEventListener('close', onClosed);
      this._removeHash();
      this._destroyOverlay();
    };
    dialog.addEventListener('closed', onClosed);
    dialog.addEventListener('close', onClosed);
  }

  // ── Header setup helpers ────────────────────────────────────────────────

  _setupDialogHeader(dialog, cfg, hasTitle, hasSubtitle, hasIcon, titleIsTPL, subtitleIsTPL) {
    if (hasIcon) {
      // Slotted title element with icon + text
      const titleEl = document.createElement('div');
      titleEl.slot = 'headerTitle';
      titleEl.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';

      const iconEl = document.createElement('ha-icon');
      iconEl.setAttribute('icon', cfg.icon);
      iconEl.style.cssText = '--mdc-icon-size:24px;flex-shrink:0;';
      titleEl.appendChild(iconEl);

      const textSpan = document.createElement('span');
      textSpan.id = 'popup-title';
      textSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      if (hasTitle && !titleIsTPL) textSpan.textContent = cfg.title;
      titleEl.appendChild(textSpan);

      dialog.appendChild(titleEl);
      if (hasSubtitle && !subtitleIsTPL) dialog.headerSubtitle = cfg.subtitle;
    } else {
      if (hasTitle && !titleIsTPL)       dialog.headerTitle    = cfg.title;
      if (hasSubtitle && !subtitleIsTPL) dialog.headerSubtitle = cfg.subtitle;
    }
  }

  _applyWidth(dialog, cfg) {
    // Desktop width
    if (WIDTH_PRESETS.has(cfg.width_desktop)) {
      dialog.width = cfg.width_desktop;
    } else if (cfg.width_desktop) {
      dialog.width = 'medium';
      dialog.style.setProperty('--ha-dialog-width-md', cfg.width_desktop);
    }
    // Mobile width (bottom-sheet)
    if (cfg.width_mobile && cfg.width_mobile !== 'full') {
      const w = MOBILE_WIDTH_PX[cfg.width_mobile] ?? cfg.width_mobile;
      dialog.style.setProperty('--ha-bottom-sheet-max-width', w);
    }
    // Desktop min-height (ha-dialog uses --ha-dialog-min-height)
    if (cfg.min_height_desktop) {
      dialog.style.setProperty('--ha-dialog-min-height', cfg.min_height_desktop);
    }
  }

  _setupCloseButton(dialog, closePos) {
    if (closePos === 'hidden' || closePos === 'right') {
      // Replace the default close button by slotting a hidden element into
      // headerNavigationIcon. This displaces the fallback content (the default
      // ha-icon-button) via standard slot behavior — no CSS hack needed,
      // and it works across desktop/mobile mode switches automatically.
      const placeholder = document.createElement('div');
      placeholder.slot = 'headerNavigationIcon';
      placeholder.style.display = 'none';
      dialog.appendChild(placeholder);
    }
  }

  // ── Post-open setup (shadow DOM dependent) ──────────────────────────────
  //
  // ha-adaptive-dialog switches between ha-dialog (desktop) and ha-bottom-sheet
  // (mobile) by replacing its shadow DOM children when the viewport changes.
  // A MutationObserver re-runs all setup whenever the inner element changes,
  // so click handlers, scroll fixes, and the ResizeObserver survive mode switches.

  _setupPostOpen(dialog, cfg) {
    // Apply all shadow-DOM-dependent patches for the current mode.
    const applySetup = () => {
      this._applyBottomSheetFixes(dialog, cfg);
      if (cfg.allow_mode_change) this._applyHeaderClickExpand(dialog);
      this._applyResizeObserver(dialog);
    };

    // Initial setup (retry until shadow DOM is ready)
    retryUntil(() => {
      if (!resolveDialogInternals(dialog)) return false;
      applySetup();

      // Watch for mode switches (ha-dialog ↔ ha-bottom-sheet replacement)
      if (dialog.shadowRoot) {
        this._modeObserver?.disconnect();
        this._modeObserver = new MutationObserver(() => {
          // Small delay to let the new element's shadow DOM initialize
          setTimeout(() => { if (this._dialog) applySetup(); }, 50);
        });
        this._modeObserver.observe(dialog.shadowRoot, { childList: true });
      }
      return true;
    });
  }

  /** Apply bottom-sheet fixes: scrollable body + optional min-height. */
  _applyBottomSheetFixes(dialog, cfg) {
    const bs = dialog.shadowRoot?.querySelector('ha-bottom-sheet');
    if (!bs?.shadowRoot) return;
    // Avoid duplicate styles
    if (bs.shadowRoot.querySelector('[data-popup-bs-fix]')) return;
    const minH = cfg.min_height_mobile ? `min-height: ${cfg.min_height_mobile};` : '';
    const style = document.createElement('style');
    style.setAttribute('data-popup-bs-fix', '');
    style.textContent = `.body { overflow-y: auto !important; scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb-color, rgba(0,0,0,.3)) transparent; ${minH} }`;
    bs.shadowRoot.appendChild(style);
  }

  /** Add click handler on header-content to toggle fullscreen, plus fullscreen CSS fixes. */
  _applyHeaderClickExpand(dialog) {
    const haDialog = dialog.shadowRoot?.querySelector('ha-dialog');
    if (!haDialog?.shadowRoot) return;
    const waDialog = haDialog.shadowRoot.querySelector('wa-dialog');
    const header = waDialog?.querySelector('ha-dialog-header');
    const headerContent = header?.shadowRoot?.querySelector('.header-content');
    if (!headerContent) return;

    // Avoid duplicate listeners (marked via data attribute)
    if (headerContent.dataset.popupClickBound) return;
    headerContent.dataset.popupClickBound = '1';
    headerContent.style.cursor = 'pointer';
    headerContent.addEventListener('click', () => {
      // Read current fullscreen state from the DOM instead of tracking manually
      const isFS = haDialog.hasAttribute('fullscreen');
      haDialog.dispatchEvent(new CustomEvent('dialog-set-fullscreen', { bubbles: false, detail: !isFS }));
    });

    // Fullscreen CSS fixes (avoid duplicates)
    if (!haDialog.shadowRoot.querySelector('[data-popup-fs-style]')) {
      const fsStyle = document.createElement('style');
      fsStyle.setAttribute('data-popup-fs-style', '');
      fsStyle.textContent = `
        :host([fullscreen]) wa-dialog::part(dialog) {
          min-height: calc(100vh - 96px) !important;
          max-height: calc(100vh - 96px) !important;
          margin-top: auto !important;
        }
        :host([fullscreen]) .body {
          padding: var(--dialog-content-padding, 0 var(--ha-space-2) var(--ha-space-6) var(--ha-space-2)) !important;
          overflow: auto !important;
        }
      `;
      haDialog.shadowRoot.appendChild(fsStyle);
    }
  }

  /** Start the ResizeObserver for animated height changes. */
  _applyResizeObserver(dialog) {
    const internals = resolveDialogInternals(dialog);
    if (internals) this._startResizeObserver(internals);
  }

  // ── Content height animation ────────────────────────────────────────────

  _startResizeObserver({ dialogEl, body, waRoot }) {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (typeof ResizeObserver === 'undefined') return;

    // Inject animation class into wa-dialog/wa-drawer shadow root
    const animStyle = document.createElement('style');
    animStyle.textContent = `dialog.height-anim { transition: height 300ms ease !important; }`;
    waRoot.appendChild(animStyle);

    let prevH = null;
    let animating = false;
    const skipUntil = Date.now() + 300;

    this._resizeObserver = new ResizeObserver(() => {
      if (animating) return;
      const newH = Math.round(dialogEl.offsetHeight);
      if (prevH === null || Date.now() < skipUntil) { prevH = newH; return; }
      if (newH === prevH) return;

      const fromH = prevH;
      prevH = newH;
      animating = true;

      // Freeze → animate → release
      dialogEl.style.height = fromH + 'px';
      dialogEl.offsetHeight; // force reflow
      dialogEl.classList.add('height-anim');
      dialogEl.style.height = newH + 'px';

      let done = false;
      const resume = () => {
        if (done) return;
        done = true;
        dialogEl.removeEventListener('transitionend', onEnd);
        dialogEl.classList.remove('height-anim');
        dialogEl.style.height = '';
        prevH = Math.round(dialogEl.offsetHeight);
        animating = false;
      };
      const onEnd = (e) => { if (e.propertyName === 'height') resume(); };
      dialogEl.addEventListener('transitionend', onEnd);
      setTimeout(resume, 350);
    });

    this._resizeObserver.observe(body);
  }

  // ── Close popup ─────────────────────────────────────────────────────────

  _closePopup(removeHash) {
    if (!this._isOpen || this._closing) return;
    this._closing = true;
    this._isOpen  = false;
    if (this._dialog) this._dialog.open = false;
    if (removeHash) this._removeHash();
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  _destroyOverlay() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._modeObserver)   { this._modeObserver.disconnect();   this._modeObserver = null;   }
    this._cancelSubscription('_titleUnsubscribe');
    this._cancelSubscription('_subtitleUnsubscribe');
    this._dialog?.remove();
    this._dialog        = null;
    this._cardEl        = null;
    this._headerBadgeEl = null;
    this._closing       = false;
    this._isOpen        = false;
    if (_registry._openDetached === this) _registry._openDetached = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Visual Editor
// ══════════════════════════════════════════════════════════════════════════════

class AdaptiveDialogCardEditor extends LitElement {

  static get properties() {
    return { _config: { state: true }, _activeTab: { state: true } };
  }

  static get styles() { return getEditorSheet(); }

  constructor() {
    super();
    this._config            = {};
    this._hass              = null;
    this._lovelace          = null;
    this._cardEditor        = null;
    this._headerBadgeEditor = null;
    this._activeTab         = 'popup';
    this._originalHash      = null;
  }

  // ── HA editor API ───────────────────────────────────────────────────────

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot?.querySelector('ha-form')?.setAttribute('hass', ''); // trigger update
    const form = this.shadowRoot?.querySelector('ha-form');
    if (form) form.hass = hass;
    if (this._cardEditor) this._cardEditor.hass = hass;
  }

  set lovelace(lovelace) {
    this._lovelace = lovelace;
    if (this._cardEditor) this._cardEditor.lovelace = lovelace;
  }

  setConfig(config) {
    this._config = { ...config };
    if (this._originalHash === null) {
      this._originalHash = normalizeHash(config.hash ?? '');
    }
  }

  // ── Form schema & data ─────────────────────────────────────────────────

  _formSchema() {
    const _ = (key) => t(this._hass, key);
    return [
      { name: 'hash',     label: _('Hash (e.g. #popup1)'),    required: true, selector: { text: {} } },
      { name: 'title',    label: _('Title'),                  selector: { text: {} } },
      { name: 'subtitle', label: _('Subtitle'),             selector: { text: {} } },
      { name: 'icon',     label: _('Icon (next to title)'), selector: { icon: {} } },
      { name: '', type: 'expandable', title: _('Size'), icon: 'mdi:resize', schema: [
        { name: 'width_desktop',      label: _('Desktop Width (e.g. medium, 400px, 50vw)'), selector: { text: {} } },
        { name: 'width_mobile',       label: _('Mobile Width (e.g. medium, 400px)'),         selector: { text: {} } },
        { name: 'min_height_desktop', label: _('Min Height Desktop (e.g. 300px, 50vh)'),        selector: { text: {} } },
        { name: 'min_height_mobile',  label: _('Min Height Mobile (e.g. 200px, 30vh)'),         selector: { text: {} } },
      ]},
      { name: '', type: 'expandable', title: _('Behavior'), icon: 'mdi:cog', schema: [
        { name: 'prevent_close', label: _('Prevent closing by clicking outside'), selector: { boolean: {} } },
        {
          name: 'close_position', label: _('Close Button Position'),
          selector: { select: { options: [
            { value: 'left',   label: _('Left') },
            { value: 'right',  label: _('Right') },
            { value: 'hidden', label: _('Hidden') },
          ] } },
        },
        { name: 'allow_mode_change', label: _('Allow mode change (Expand, Viewport Switch)'), selector: { boolean: {} } },
      ]},
    ];
  }

  _formData() {
    return {
      hash:               this._config.hash               ?? '#popup1',
      title:              this._config.title              ?? '',
      subtitle:           this._config.subtitle           ?? '',
      icon:               this._config.icon               ?? '',
      width_desktop:      this._config.width_desktop      ?? '',
      width_mobile:       this._config.width_mobile       ?? '',
      min_height_desktop: this._config.min_height_desktop ?? '',
      min_height_mobile:  this._config.min_height_mobile  ?? '',
      prevent_close:      this._config.prevent_close      ?? false,
      close_position:     this._config.close_position     ?? 'left',
      allow_mode_change:  this._config.allow_mode_change  ?? true,
    };
  }

  // ── Duplicate detection ─────────────────────────────────────────────────

  _isDuplicateHash() {
    const hash = this._config?.hash;
    if (!hash) return false;
    const normalized = normalizeHash(hash);
    const config = this._lovelace?.config || getLovelaceConfig();
    if (!config) return false;

    let count = 0;
    for (const view of (config.views ?? [])) {
      const cards = [...(view.cards ?? [])];
      for (const section of (view.sections ?? [])) cards.push(...(section.cards ?? []));
      for (const cfg of findPopupConfigs(cards)) {
        if (normalizeHash(cfg.hash) === normalized) count++;
      }
    }
    return normalized !== this._originalHash ? count >= 1 : count > 1;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  render() {
    const hasCard  = !!this._config.card?.type;
    const hasBadge = !!this._config.header_badge?.type;
    const isDup    = this._isDuplicateHash();

    return html`
      ${isDup ? html`<ha-alert alert-type="warning">${t(this._hass, 'The hash "{hash}" is already used by another popup card.', { hash: this._config.hash })}</ha-alert>` : ''}

      <div class="tabs">
        ${['popup', 'badge', 'content'].map(tab => html`
          <button class="tab ${this._activeTab === tab ? 'active' : ''}"
                  @click=${() => { this._activeTab = tab; }}>
            ${tab === 'popup' ? t(this._hass, 'Popup') : tab === 'badge' ? t(this._hass, 'Badge') : t(this._hass, 'Content')}
          </button>
        `)}
      </div>

      <div class="tab-panel ${this._activeTab === 'popup' ? 'active' : ''}">
        <ha-form .schema=${this._formSchema()} .data=${this._formData()} .hass=${this._hass}
                 .computeLabel=${(s) => s.label} @value-changed=${this._onFormChanged}></ha-form>
      </div>

      <div class="tab-panel ${this._activeTab === 'badge' ? 'active' : ''}">
        <div class="change-bar">
          ${hasBadge ? html`<ha-button @click=${this._onChangeBadge}>${t(this._hass, 'Change Badge')}</ha-button>` : ''}
        </div>
        <div id="header-badge-slot"></div>
      </div>

      <div class="tab-panel ${this._activeTab === 'content' ? 'active' : ''}">
        <div class="change-bar">
          ${hasCard ? html`<ha-button @click=${this._onChangeCard}>${t(this._hass, 'Change Card')}</ha-button>` : ''}
        </div>
        <div id="card-slot"></div>
      </div>
    `;
  }

  updated(changedProps) {
    if (changedProps.has('_config')) {
      this._refreshSubEditor('card', 'card-slot', '_cardEditor');
      this._refreshBadgeEditor();
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  _onFormChanged(e) {
    e.stopPropagation();
    this._config = { ...this._config, ...e.detail.value };
    this._fireConfigChanged();
  }

  _onChangeCard() {
    const { card: _, ...rest } = this._config;
    this._config = rest;
    this._fireConfigChanged();
  }

  _onChangeBadge() {
    const { header_badge: _, ...rest } = this._config;
    this._config = rest;
    this._fireConfigChanged();
  }

  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }

  // ── Sub-editor management ───────────────────────────────────────────────

  _refreshSubEditor(configKey, slotId, editorProp) {
    const slot = this.shadowRoot?.getElementById(slotId);
    if (!slot) return;
    const cardConfig = this._config[configKey];

    if (cardConfig?.type) {
      if (this[editorProp]?.localName === 'hui-card-element-editor') {
        this[editorProp].value = cardConfig;
        return;
      }
      slot.replaceChildren();
      this[editorProp] = null;
      this._mountElementEditor(slot, cardConfig, configKey, editorProp);
    } else {
      if (this[editorProp]?.localName === 'hui-card-picker') return;
      slot.replaceChildren();
      this[editorProp] = null;
      this._mountCardPicker(slot, configKey, editorProp);
    }
  }

  _refreshBadgeEditor() {
    const slot = this.shadowRoot?.getElementById('header-badge-slot');
    if (!slot) return;
    const badgeConfig = this._config.header_badge;

    if (badgeConfig?.type) {
      if (this._headerBadgeEditor?.localName === 'hui-card-element-editor') {
        this._headerBadgeEditor.value = badgeConfig;
        return;
      }
      slot.replaceChildren();
      this._headerBadgeEditor = null;
      this._mountElementEditor(slot, badgeConfig, 'header_badge', '_headerBadgeEditor');
    } else {
      if (this._headerBadgeEditor?.localName === 'ha-form') return;
      slot.replaceChildren();
      this._headerBadgeEditor = null;
      this._mountBadgePicker(slot);
    }
  }

  _mountCardPicker(slot, configKey, editorProp) {
    const mount = () => {
      const picker = document.createElement('hui-card-picker');
      picker.hass = this._hass;
      picker.lovelace = this._lovelace;
      picker.addEventListener('config-changed', (e) => {
        e.stopPropagation();
        if (!e.detail?.config) return;
        this._config = { ...this._config, [configKey]: e.detail.config };
        this._fireConfigChanged();
        this._refreshSubEditor(configKey, slot.id, editorProp);
      });
      slot.appendChild(picker);
      this[editorProp] = picker;
    };
    customElements.get('hui-card-picker') ? mount() : customElements.whenDefined('hui-card-picker').then(mount);
  }

  _mountElementEditor(slot, cardConfig, configKey, editorProp) {
    const mount = () => {
      const editor = document.createElement('hui-card-element-editor');
      editor.hass = this._hass;
      editor.lovelace = this._lovelace;
      editor.value = cardConfig;
      editor.addEventListener('config-changed', (e) => {
        e.stopPropagation();
        if (!e.detail?.config) return;
        this._config = { ...this._config, [configKey]: e.detail.config };
        this._fireConfigChanged();
      });
      editor.addEventListener('GUImode-changed', (e) => e.stopPropagation());
      slot.appendChild(editor);
      this[editorProp] = editor;
    };
    customElements.get('hui-card-element-editor') ? mount() : customElements.whenDefined('hui-card-element-editor').then(mount);
  }

  _mountBadgePicker(slot) {
    const customOpts = (window.customBadges ?? []).map(b => ({ value: `custom:${b.type}`, label: b.name || b.type }));
    const options = [{ value: 'entity', label: t(this._hass, 'Entity Badge') }, ...customOpts];
    const mount = () => {
      const form = document.createElement('ha-form');
      form.hass = this._hass;
      form.schema = [{ name: 'type', label: t(this._hass, 'Badge Type'), selector: { select: { options, mode: 'dropdown' } } }];
      form.data = { type: '' };
      form.computeLabel = (s) => s.label;
      form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        const type = e.detail.value?.type;
        if (!type) return;
        this._config = { ...this._config, header_badge: { type } };
        this._fireConfigChanged();
        this._refreshBadgeEditor();
      });
      slot.appendChild(form);
      this._headerBadgeEditor = form;
    };
    customElements.get('ha-form') ? mount() : customElements.whenDefined('ha-form').then(mount);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Registration
// ══════════════════════════════════════════════════════════════════════════════

customElements.define(CARD_TAG,   AdaptiveDialogCard);
customElements.define(EDITOR_TAG, AdaptiveDialogCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type:        CARD_TAG,
    name:        'HA Adaptive Dialog Card',
    description: 'Popup card based on ha-adaptive-dialog.',
    preview:     false,
  });
}

console.info(
  `%c HA-ADAPTIVE-DIALOG-CARD %c v${VERSION} `,
  'background:#0078d4;color:#fff;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px;',
  'background:#005a9e;color:#fff;border-radius:0 3px 3px 0;padding:2px 6px;',
);
