/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// TabOmnibar: 双击激活标签页，将其原位变为地址栏（Omnibar）。
// 复用全局单例 UrlbarInput（gURLBar），编辑态下传统地址栏（#nav-bar）完全折叠。
//
// 三种模式（browser.tabomnibar.mode）:
// - "in" (默认): urlbar-container DOM 移入激活 tab 并铺满, tab 按中点压缩规则展开。
// - "floatA": 固定大小浮层, 水平居中;  tab 自身不变。
// - "floatB": 固定大小浮层, 水平左端;  tab 自身不变。
// - "aligned": 浮层左对齐激活 tab, 向右扩展到 tab 栏右端, 位于 tab 下方; tab 自身不变。
// browser.tabomnibar.overlay: true=浮层与 tab 一平盖住 tab 栏; false=浮层位于 tab 栏下方。
// float/aligned 浮层以 position:fixed 挂 body, 规避 navigator-toolbox 的 overflow:clip 裁剪。

const OMNIBAR_TRANSITION_MS = 280;
const TAB_OMNIBAR_WIDTH = 360;
const TAB_OMNIBAR_MIN_WIDTH = 280;
const TAB_OMNIBAR_MAX_WIDTH = 420;
const TAB_ICON_WIDTH = 44;
const TAB_MIN_WIDTH = 76;
const FLOAT_WIDTH = 480;
const FLOAT_HEIGHT = 44;
const { STATE_IS_SECURE, STATE_IS_INSECURE, STATE_IS_BROKEN } =
  Ci.nsIWebProgressListener;

export class TabOmnibar {
  #container;
  #active = false;
  #activeTab = null;
  #savedScrollLeft = 0;
  #pendingLayoutRefresh = false;
  #cleanupTimer = 0;
  #squeezedTabs = [];
  #urlbarOriginalParent = null;
  #urlbarOriginalNextSibling = null;
  #mode = "in";
  #overlay = true;
  activeWidth = 0;

  constructor(container) {
    this.#container = container;
    this.window = container.ownerDocument.defaultView;
    this.navBar = this.window.document.getElementById("nav-bar");
    this.urlbar = this.window.document.getElementById("urlbar");
    this.urlbarContainer = this.window.document.getElementById(
      "urlbar-container"
    );
    this.gURLBar = this.window.gURLBar;
    this.arrowScrollbox = container.arrowScrollbox;

    this.#readPrefs();
    Services.prefs.addObserver("browser.tabomnibar.mode", this);
    Services.prefs.addObserver("browser.tabomnibar.overlay", this);

    container.addEventListener("TabSelect", this);
    container.addEventListener("TabOpen", this, true);
    container.addEventListener("TabClose", this, true);
    this.window.addEventListener("keydown", this, true);
    this.window.addEventListener("resize", this);
    this.urlbar.addEventListener("focusout", this);
    this.urlbar.addEventListener("keydown", this);

    // hover 提示: 地址栏默认不可见, tooltip 需补上 URL(前 100 字符)。
    // 在 mainPopupSet 上委托监听, 保证晚于原生 createTooltip 执行。
    this.window.document
      .getElementById("mainPopupSet")
      ?.addEventListener("popupshowing", this);

    this.window.gBrowser.addTabsProgressListener(this);
    this.#refreshSecurityIndicators();
  }

  get active() {
    return this.#active;
  }

  get mode() {
    return this.#mode;
  }

  observe(subject, topic, data) {
    if (topic != "nsPref:changed") {
      return;
    }
    if (
      data == "browser.tabomnibar.mode" ||
      data == "browser.tabomnibar.overlay"
    ) {
      this.#readPrefs();
      if (this.#active) {
        this.exit();
      }
    }
  }

  #readPrefs() {
    this.#mode = Services.prefs.getStringPref(
      "browser.tabomnibar.mode",
      "in"
    );
    this.#overlay = Services.prefs.getBoolPref(
      "browser.tabomnibar.overlay",
      true
    );
  }

  handleEvent(event) {
    switch (event.type) {
      case "TabSelect":
        if (this.#active) {
          this.exit();
        }
        break;
      case "TabOpen":
        if (this.#active) {
          this.#pendingLayoutRefresh = true;
          event.stopImmediatePropagation();
        } else {
          // 新 tab 打开后自动进入编辑态, 让用户直接输入地址。
          let newTab = event.target;
          this.window.setTimeout(() => {
            this.maybeEnter(newTab);
          }, 80);
        }
        break;
      case "keydown":
        if (!this.#active) {
          break;
        }
        if (event.eventPhase == Event.CAPTURING_PHASE) {
          let accel = event.ctrlKey || event.metaKey;
          if (
            accel &&
            ["Tab", "PageUp", "PageDown"].includes(event.key)
          ) {
            // Ctrl+Tab / Ctrl+PageUp / Ctrl+PageDown: 退出 Omnibar 态但不拦截,
            // 让事件继续流向 tabbox / ctrlTab 的默认切换逻辑。
            this.exit();
          }
        } else if (event.key == "Escape") {
          this.exit();
        } else if (event.key == "Enter" && !event.isComposing) {
          // Enter 提交: 退出编辑态, 不拦截默认导航。
          this.exit();
        }
        break;
      case "focusout":
        if (this.#active && event.target == this.gURLBar.inputField) {
          this.exit();
        }
        break;
      case "resize":
        if (this.#active && this.#mode != "in") {
          this.#applyFloatPosition(this.#activeTab);
        }
        break;
      case "popupshowing":
        if (event.target.id == "tabbrowser-tab-tooltip") {
          let tab = event.target.triggerNode?.closest?.("tab");
          if (tab && !tab._overPlayingIcon && !tab._overAudioButton) {
            let url = tab.linkedBrowser?.currentURI?.spec;
            if (url && !url.startsWith("about:")) {
              let truncated =
                url.length > 100 ? url.slice(0, 100) + "…" : url;
              event.target.label =
                (event.target.label ? event.target.label + "\n" : "") +
                truncated;
            }
          }
        }
        break;
    }
  }

  onSecurityChange(browser, webProgress, request, state) {
    let tab = this.window.gBrowser.getTabForBrowser(browser);
    if (tab) {
      this.#updateSecurityIndicator(tab, state);
    }
  }

  onLocationChange(browser, webProgress, request, locationURI, flags) {
    if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
      return;
    }
    let tab = this.window.gBrowser.getTabForBrowser(browser);
    if (tab) {
      // 加载中: 进度条接管视觉, 安全线保持中性。
      tab.setAttribute("tabsecurity", "loading");
    }
  }

  /**
   * 双击当前已激活 tab 时进入 Omnibar 态。
   */
  maybeEnter(tab) {
    if (
      this.#active ||
      tab.pinned ||
      this.#container.verticalMode ||
      tab != this.window.gBrowser.selectedTab
    ) {
      return;
    }

    this.#active = true;
    this.#activeTab = tab;
    this.#pendingLayoutRefresh = false;

    if (this.#mode == "in") {
      if (!this.#enterInPlace(tab)) {
        this.#active = false;
        this.#activeTab = null;
        return;
      }
    } else {
      this.#enterFloat(tab);
    }

    this.gURLBar.setURI({ uri: tab.linkedBrowser.currentURI });
    this.gURLBar.focus();
    this.gURLBar.select();
  }

  #enterInPlace(tab) {
    let { urlbar, urlbarContainer } = this;
    let container = this.#container;
    this.#savedScrollLeft = this.arrowScrollbox.scrollPosition;

    if (!this.#applyMidpointCompression(tab)) {
      return false;
    }

    this.#urlbarOriginalParent = urlbarContainer.parentNode;
    this.#urlbarOriginalNextSibling = urlbarContainer.nextSibling;
    tab.appendChild(urlbarContainer);
    urlbarContainer.style.cssText =
      "display:block;position:absolute;top:0;left:0;right:0;bottom:0;z-index:10;padding:0;margin:0;width:" +
      this.activeWidth +
      "px;";

    container.setAttribute("tabomnibar-active", "");
    tab.setAttribute("tabomnibar-active", "");
    urlbar.setAttribute("tabomnibar", "");
    return true;
  }

  #enterFloat(tab) {
    let { urlbar, urlbarContainer } = this;
    this.#urlbarOriginalParent = urlbarContainer.parentNode;
    this.#urlbarOriginalNextSibling = urlbarContainer.nextSibling;
    this.#floatStrip().appendChild(urlbarContainer);
    this.#applyFloatPosition(tab);
    urlbarContainer.setAttribute("tabomnibar-float", "");
    this.#container.setAttribute("tabomnibar-active", "");
    urlbar.setAttribute("tabomnibar", "");
  }

  #applyFloatPosition(tab) {
    let { left, top, width, height } = this.#floatLayout(tab);
    this.urlbarContainer.style.cssText =
      "display:block;position:absolute;left:" +
      left +
      "px;top:" +
      top +
      "px;width:" +
      width +
      "px;height:" +
      height +
      "px;z-index:100;padding:0 8px;margin:0;";
  }

  #floatLayout(tab) {
    let strip = this.#floatStrip();
    let tabRect = tab.getBoundingClientRect();
    let stripRect = strip.getBoundingClientRect();
    let height = stripRect.height;
    let left;
    let width = FLOAT_WIDTH;
    if (this.#mode == "floatA") {
      // 水平居中。
      left = Math.round((stripRect.width - FLOAT_WIDTH) / 2);
    } else if (this.#mode == "floatB") {
      // 水平左端(贴 tab 栏左缘)。
      left = 8;
    } else {
      // aligned: 左对齐激活 tab, 不向左挤压, 向右扩展到 tab 栏右端。
      left = tabRect.left - stripRect.left;
      width = Math.max(FLOAT_WIDTH, stripRect.right - tabRect.left - 8);
    }
    // aligned 固定位于 tab 下方; float 由 overlay 决定(与 tab 一平或下方)。
    let top =
      this.#mode == "aligned" || !this.#overlay
        ? stripRect.height
        : 0;
    return { left, top, width, height };
  }

  #floatStrip() {
    return this.#container.parentNode;
  }

  /**
   * 退出 Omnibar 态: urlbar-container 立即移回 nav-bar。
   */
  exit() {
    if (!this.#active) {
      return;
    }
    this.#active = false;

    if (this.#pendingLayoutRefresh) {
      this.#pendingLayoutRefresh = false;
      this.#container._handleTabSelect(true);
    }

    let { urlbar, urlbarContainer, activeTab } = this;
    let container = this.#container;
    let strip = this.#floatStrip();

    urlbar.removeAttribute("tabomnibar");
    urlbarContainer.removeAttribute("tabomnibar-float");
    activeTab?.removeAttribute("tabomnibar-active");
    container.removeAttribute("tabomnibar-active");
    strip.removeAttribute("tabomnibar-float");
    strip.removeAttribute("tabomnibar-mode");
    strip.removeAttribute("tabomnibar-overlay");

    for (let t of this.#squeezedTabs) {
      t.style.maxWidth = "";
      t.style.minWidth = "";
    }

    if (this.#urlbarOriginalParent) {
      this.#urlbarOriginalParent.insertBefore(
        urlbarContainer,
        this.#urlbarOriginalNextSibling
      );
    }
    this.#urlbarOriginalParent = null;
    this.#urlbarOriginalNextSibling = null;

    if (this.#mode == "in") {
      clearTimeout(this.#cleanupTimer);
      this.#cleanupTimer = setTimeout(() => {
        urlbarContainer.style.cssText = "";
        this.arrowScrollbox.scrollbox.scrollLeft = this.#savedScrollLeft;
        this.#squeezedTabs = [];
        this.#activeTab = null;
      }, OMNIBAR_TRANSITION_MS + 50);
    } else {
      urlbarContainer.style.cssText = "";
      this.#squeezedTabs = [];
      this.#activeTab = null;
    }
  }

  /**
   * 中点压缩规则:
   * - tab 中心 <= 视口中点: 左侧保持完整宽度, 当前 tab 向右展开, 右侧顺延、超出等宽缩窄。
   * - tab 中心 > 视口中点: 左侧非 pinned 标签压缩为纯图标态, 释放空间给当前 tab。
   * - pinned 标签位于独立容器, 天然排除。
   */
  #applyMidpointCompression(tab) {
    let win = this.window;
    let winUtils = win.windowUtils;
    let arrow = this.arrowScrollbox;
    // 可见视口 = scrollbox 内部区域（不含滚动按钮）。
    let viewport = winUtils.getBoundsWithoutFlushing(arrow.scrollbox);
    let tabRect = winUtils.getBoundsWithoutFlushing(tab);
    let tabCenter = tabRect.left + tabRect.width / 2;
    let viewportCenter = viewport.left + viewport.width / 2;
    let leftMode = tabCenter <= viewportCenter;

    let allTabs = this.#container.visibleTabs;
    let numPinned = win.gBrowser.pinnedTabCount;
    let tabs = allTabs.slice(numPinned).filter(t => !t.closing && !t.hidden);
    let idx = tabs.indexOf(tab);
    if (idx < 0) {
      return false;
    }
    let leftTabs = tabs.slice(0, idx);
    let rightTabs = tabs.slice(idx + 1);

    let available = viewport.width;
    let expandWidth = Math.min(
      TAB_OMNIBAR_MAX_WIDTH,
      Math.max(TAB_OMNIBAR_MIN_WIDTH, TAB_OMNIBAR_WIDTH)
    );
    expandWidth = Math.min(expandWidth, Math.max(available - 60, 160));
    this.activeWidth = expandWidth;

    let squeezed = [];
    let leftWidth;

    if (leftMode) {
      // 左侧保持完整宽度。
      leftWidth = leftTabs.reduce(
        (sum, t) => sum + winUtils.getBoundsWithoutFlushing(t).width,
        0
      );
      let rightWidth = rightTabs.reduce(
        (sum, t) => sum + winUtils.getBoundsWithoutFlushing(t).width,
        0
      );
      let need = leftWidth + expandWidth + rightWidth;
      let perRight =
        need > available
          ? (available - leftWidth - expandWidth) / rightTabs.length
          : 0;
      for (let t of rightTabs) {
        if (perRight > 0) {
          t.style.setProperty(
            "max-width",
            Math.max(perRight, TAB_MIN_WIDTH) + "px",
            "important"
          );
          squeezed.push(t);
        }
      }
    } else {
      // 左侧压缩为纯图标态。
      leftWidth = leftTabs.length * TAB_ICON_WIDTH;
      for (let t of leftTabs) {
        t.style.setProperty(
          "max-width",
          TAB_ICON_WIDTH + "px",
          "important"
        );
        t.style.setProperty("min-width", TAB_ICON_WIDTH + "px", "important");
        squeezed.push(t);
      }
      let rightWidth = rightTabs.reduce(
        (sum, t) => sum + winUtils.getBoundsWithoutFlushing(t).width,
        0
      );
      let need = leftWidth + expandWidth + rightWidth;
      let perRight =
        need > available
          ? (available - leftWidth - expandWidth) / rightTabs.length
          : 0;
      for (let t of rightTabs) {
        if (perRight > 0) {
          t.style.setProperty(
            "max-width",
            Math.max(perRight, TAB_MIN_WIDTH) + "px",
            "important"
          );
          squeezed.push(t);
        }
      }
    }

    tab.style.setProperty("max-width", expandWidth + "px", "important");
    tab.style.setProperty("min-width", expandWidth + "px", "important");
    squeezed.push(tab);
    this.#squeezedTabs = squeezed;
    return true;
  }

  #updateSecurityIndicator(tab, state) {
    let sec;
    if (state & STATE_IS_BROKEN) {
      sec = "broken";
    } else if (state & STATE_IS_INSECURE) {
      sec = "insecure";
    } else if (state & STATE_IS_SECURE) {
      sec = "secure";
    } else {
      sec = "neutral";
    }
    tab.setAttribute("tabsecurity", sec);
  }

  #refreshSecurityIndicators() {
    for (let tab of this.window.gBrowser.tabs) {
      let browser = tab.linkedBrowser;
      if (browser?.securityUI) {
        this.#updateSecurityIndicator(tab, browser.securityUI.state);
      }
    }
  }
}
