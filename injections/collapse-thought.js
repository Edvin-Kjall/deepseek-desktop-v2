/**
 * Injected into chat.deepseek.com. Collapses auto-expanded “Thought for …” sections.
 *
 * 1) querySelectorAllDeep — searches open shadow roots (chat may mount under shadow DOM).
 * 2) Block match — inline style contains --collapsible-area-title-height (your div._…).
 * 3) Main process sends REAL mouse events (see main.js sendNativeThoughtToggleClick) because
 *    React often ignores el.click() for delegated/pointer handlers.
 *
 * The main process sets window.__DS_DESKTOP_COLLAPSE_THOUGHT__ to false to opt out.
 */
(function desktopThoughtCollapseIIFE() {
  if (window.__dsDesktopThoughtInjected) {
    if (window.__dsDesktopThoughtCollapseRun) {
      window.__dsDesktopThoughtCollapseRun();
    }
    return;
  }
  window.__dsDesktopThoughtInjected = true;
  const PREF = '__DS_DESKTOP_COLLAPSE_THOUGHT__';
  const processed = new WeakSet();

  function isEnabled() {
    if (Object.prototype.hasOwnProperty.call(window, PREF) && window[PREF] === false) {
      return false;
    }
    return true;
  }

  function firstLine(text) {
    if (!text) {
      return '';
    }
    return String(text)
      .replace(/\r/g, '\n')
      .split('\n')
      [0]
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeThoughtHeaderLine(line) {
    if (!line || line.length > 200) {
      return false;
    }
    return /^Thought for \d+\s*(second|minute)s?/i.test(line);
  }

  function parseCssPx(v) {
    if (v == null) {
      return 0;
    }
    const m = String(v).match(/-?[\d.]+/);
    return m ? parseFloat(m[0]) : 0;
  }

  /**
   * Collect every open #shadow-root under document (React/custom elements sometimes hide chat here).
   */
  function walkShadows(node, out) {
    if (!node) {
      return;
    }
    if (node.shadowRoot) {
      out.push(node.shadowRoot);
      const kids = node.shadowRoot.children ? Array.from(node.shadowRoot.children) : [];
      kids.forEach((c) => walkShadows(c, out));
      node.shadowRoot.querySelectorAll('*').forEach((c) => {
        if (c !== node && c.shadowRoot) {
          walkShadows(c, out);
        }
      });
    }
    if (node.children) {
      Array.from(node.children).forEach((c) => walkShadows(c, out));
    }
  }

  function allDocumentRoots() {
    const out = [document];
    if (document.documentElement) {
      walkShadows(document.documentElement, out);
    }
    return out;
  }

  /** qSA on document + every reachable open shadow root; dedupes the same node. */
  function querySelectorAllDeep(sel) {
    const found = [];
    const seen = new Set();
    allDocumentRoots().forEach((root) => {
      const base = root;
      if (!base || !base.querySelectorAll) {
        return;
      }
      try {
        base.querySelectorAll(sel).forEach((el) => {
          if (seen.has(el)) {
            return;
          }
          seen.add(el);
          found.push(el);
        });
      } catch {
        /* ignore */
      }
    });
    return found;
  }

  function getCollapsibleTitleHeightPx(block) {
    const inline = block.getAttribute('style') || '';
    const m1 = inline.match(/--collapsible-area-title-height:\s*([^;]+)/i);
    if (m1) {
      const p = parseCssPx(m1[1]);
      if (p > 0) {
        return p;
      }
    }
    let fromComputed = 0;
    try {
      fromComputed = parseCssPx(window.getComputedStyle(block).getPropertyValue('--collapsible-area-title-height'));
    } catch {
      fromComputed = 0;
    }
    return fromComputed > 0 ? fromComputed : 38;
  }

  function dataStateInSubtree(root) {
    const list = [root, ...root.querySelectorAll('[data-state]')];
    let open = false;
    let closed = false;
    list.forEach((n) => {
      const s = n.getAttribute && n.getAttribute('data-state');
      if (s === 'open') {
        open = true;
      }
      if (s === 'closed') {
        closed = true;
      }
    });
    return { open, closed };
  }

  const COLLAPSE_BLOCK_SELS = [
    '[style*="--collapsible-area-title-height"]',
    '[style*="collapsible-area-title-height"]',
  ];

  function isInsideStyleCollapsible(el) {
    for (let k = 0; k < COLLAPSE_BLOCK_SELS.length; k += 1) {
      try {
        if (el.closest && el.closest(COLLAPSE_BLOCK_SELS[k])) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    for (let k = 0; k < COLLAPSE_BLOCK_SELS.length; k += 1) {
      try {
        if (el.matches && el.matches(COLLAPSE_BLOCK_SELS[k])) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function findAllCollapsibleBlocks() {
    const set = new Set();
    const list = [];
    COLLAPSE_BLOCK_SELS.forEach((sel) => {
      querySelectorAllDeep(sel).forEach((block) => {
        if (set.has(block)) {
          return;
        }
        set.add(block);
        list.push(block);
      });
    });
    return list;
  }

  function findTriggerForCollapsibleBlock(block) {
    let trigger = block.querySelector('button, [role="button"]');
    if (!trigger) {
      const sub = block.querySelectorAll('div, span, [role="button"]');
      for (let k = 0; k < sub.length; k += 1) {
        const c = sub[k];
        if (!block.contains(c)) {
          continue;
        }
        const t = firstLine(c.innerText || c.textContent || '');
        if (!looksLikeThoughtHeaderLine(t)) {
          continue;
        }
        if (c.getBoundingClientRect().height > 120) {
          continue;
        }
        trigger = c;
        break;
      }
    }
    if (!trigger) {
      trigger = block.firstElementChild;
    }
    return trigger;
  }

  function blockStillLooksExpanded(block) {
    const { open: stOpen, closed: stClosed } = dataStateInSubtree(block);
    if (stClosed && !stOpen) {
      return false;
    }
    const titleH = getCollapsibleTitleHeightPx(block);
    const h = block.getBoundingClientRect().height;
    return stOpen || h > titleH + 20;
  }

  /**
   * React 18+ often wires `onPointerDown` / `onClick` on the title row. A single `click()`
   * is ignored; `sendInputEvent` from Electron can also miss the internal hit target.
   * This dispatches the same sequence the browser would for a real click.
   * @param {Element} el
   * @param {number} x clientX
   * @param {number} y clientY
   */
  function dispatchReactFriendlyPointerClick(el, x, y) {
    const base = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
      button: 0,
    };
    try {
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: 1,
          pressure: 0.5,
        }),
      );
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: 0,
          pressure: 0,
        }),
      );
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
    } catch {
      /* ignore */
    }
  }

  /**
   * Runs the in-page click sequence on the thought title. Called from main after injection;
   * returns true if a toggle was dispatched.
   */
  window.__dsDesktopPerformCollapseClick = function performCollapseClick() {
    if (!isEnabled()) {
      return false;
    }
    const blocks = findAllCollapsibleBlocks();
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (!blockStillLooksExpanded(block)) {
        continue;
      }
      const trigger = findTriggerForCollapsibleBlock(block);
      if (!trigger) {
        continue;
      }
      const r = trigger.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      let target = trigger;
      try {
        const at = document.elementFromPoint(x, y);
        if (at && trigger.contains(at)) {
          target = at;
        }
      } catch {
        /* ignore */
      }
      dispatchReactFriendlyPointerClick(target, x, y);
      return true;
    }
    return false;
  };

  /**
   * Exposed to main process: returns { left, top, width, height } of the **title row** to click,
   * or null. Used as fallback when in-page perform is not enough.
   */
  window.__dsDesktopGetThoughtToggleRect = function getThoughtToggleRect() {
    if (!isEnabled()) {
      return null;
    }
    const blocks = findAllCollapsibleBlocks();
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (!blockStillLooksExpanded(block)) {
        continue;
      }
      const trigger = findTriggerForCollapsibleBlock(block);
      if (!trigger) {
        continue;
      }
      const r = trigger.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        continue;
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    }
    return null;
  };

  function collapseByCollapsibleStyle() {
    /* Clicks for this path are done in main via sendInputEvent; avoids React ignoring el.click(). */
  }

  function isExpandedRegion(el) {
    let p = el;
    for (let d = 0; d < 12 && p; d += 1) {
      const st = p.getAttribute && p.getAttribute('data-state');
      if (st === 'open') {
        return true;
      }
      if (st === 'closed') {
        return false;
      }
      const ae = p.getAttribute && p.getAttribute('aria-expanded');
      if (ae === 'true') {
        return true;
      }
      if (ae === 'false') {
        return false;
      }
      p = p.parentElement;
    }
    let n = el;
    for (let u = 0; u < 6; u += 1) {
      if (!n) {
        break;
      }
      const pr = n.parentElement;
      if (!pr) {
        break;
      }
      const ch = Array.from(pr.children);
      const i = ch.indexOf(n);
      for (let j = i + 1; j < ch.length; j += 1) {
        const t = (ch[j].innerText || ch[j].textContent || '').trim();
        if (t.length > 80) {
          return true;
        }
      }
      n = pr;
    }
    return true;
  }

  function getClickTarget(el) {
    const btn = el.querySelector('button, [role="button"]');
    if (btn) {
      return btn;
    }
    if (el.matches && el.matches('button, [role="button"]')) {
      return el;
    }
    let n = el;
    for (let d = 0; d < 5 && n; d += 1) {
      if (n.getAttribute && (n.getAttribute('tabindex') === '0' || n.getAttribute('role') === 'button')) {
        return n;
      }
      if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') {
        return n;
      }
      n = n.parentElement;
    }
    return el;
  }

  function dropAncestorsInSet(cands) {
    return cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
  }

  function findThoughtHeaderElements() {
    const out = [];
    const seen = new Set();
    const list = document.querySelectorAll('div, button, span, [role="button"], header, section');
    list.forEach((el) => {
      if (isInsideStyleCollapsible(el)) {
        return;
      }
      const line = firstLine(el.innerText || el.textContent || '');
      if (!looksLikeThoughtHeaderLine(line)) {
        return;
      }
      const h = el.getBoundingClientRect().height;
      const w = el.getBoundingClientRect().width;
      if (h < 4 || w < 20) {
        return;
      }
      if (h > 220) {
        return;
      }
      if ((el.innerText || '').length > 800) {
        return;
      }
      if (seen.has(el)) {
        return;
      }
      seen.add(el);
      out.push(el);
    });
    if (out.length === 0) {
      return [];
    }
    out.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    const m = out[0].getBoundingClientRect().height;
    const thin = out.filter((e) => e.getBoundingClientRect().height <= m + 8);
    return dropAncestorsInSet(thin);
  }

  function triggerClick(el) {
    try {
      el.click();
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
  }

  function collapseIfNeeded() {
    if (!isEnabled()) {
      return;
    }
    collapseByCollapsibleStyle();
    const headers = findThoughtHeaderElements();
    headers.forEach((header) => {
      if (processed.has(header)) {
        return;
      }
      if (!isExpandedRegion(header)) {
        processed.add(header);
        return;
      }
      const target = getClickTarget(header);
      if (processed.has(target)) {
        return;
      }
      try {
        triggerClick(target);
      } catch {
        /* ignore */
      }
      processed.add(header);
      processed.add(target);
    });
  }

  function debounce(fn, ms) {
    let t;
    return function debounced() {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  const onMut = debounce(function onMutation() {
    collapseIfNeeded();
    [120, 400, 1000, 2200].forEach((delay) => {
      setTimeout(collapseIfNeeded, delay);
    });
  }, 50);

  function install() {
    if (window.__dsDesktopThoughtCollapseObserver) {
      try {
        window.__dsDesktopThoughtCollapseObserver.disconnect();
      } catch {
        /* ignore */
      }
    }
    const ob = new MutationObserver(onMut);
    if (document.body) {
      ob.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'data-state', 'class', 'style'],
        characterData: true,
      });
    }
    window.__dsDesktopThoughtCollapseObserver = ob;
  }

  window.__dsDesktopThoughtCollapseRun = function runDesktopThoughtCollapse() {
    if (!isEnabled()) {
      return;
    }
    install();
    collapseIfNeeded();
    [0, 32, 100, 300, 800, 1600, 3000].forEach((d) => {
      setTimeout(collapseIfNeeded, d);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function onDom() {
      document.removeEventListener('DOMContentLoaded', onDom);
      window.__dsDesktopThoughtCollapseRun();
    });
  } else {
    window.__dsDesktopThoughtCollapseRun();
  }
})();
