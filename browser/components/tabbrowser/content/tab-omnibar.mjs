/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// TabOmnibar: 双击激活标签页，将其原位变为地址栏（Omnibar）。
// 复用全局单例 UrlbarInput（gURLBar），编辑态下传统地址栏（#nav-bar）完全折叠。
//
// 三种模式（browser.tabomnibar.mode）:
// - "in" (默认): urlbar-container DOM 移入激活 tab 并铺满, tab 按中点压缩规则展开。
// - "floatA": 固定大小浮层; tab 自身不变。
// - "floatB": 固定大小浮层(与 floatA 行为一致, 保留名称兼容); tab 自身不变。
// - "aligned": 浮层左对齐激活 tab, 向右扩展到 tab 栏右端, 位于 tab 下方; tab 自身不变。
// browser.tabomnibar.overlay: true=浮层与 tab 一平盖住 tab 栏; false=浮层位于 tab 栏下方。
// browser.tabomnibar.floatPos: float 浮层水平锚定; "follow"=与激活 tab 左侧对齐, "center"=窗口水平居中。

const OMNIBAR_TRANSITION_MS = 280;
const TAB_OMNIBAR_WIDTH = 360;
const TAB_OMNIBAR_MIN_WIDTH = 280;
const TAB_OMNIBAR_MAX_WIDTH = 420;
const TAB_ICON_WIDTH = 44;
const TAB_MIN_WIDTH = 100;
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
  #floatPos = "follow";
  #securityIndicator = "line";
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
    Services.prefs.addObserver("browser.tabomnibar.floatPos", this);

    container.addEventListener("TabSelect", this);
    container.addEventListener("TabOpen", this, true);
    container.addEventListener("TabClose", this, true);
    this.window.addEventListener("keydown", this, true);
    this.window.addEventListener("resize", this);
    this.urlbar.addEventListener("focusout", this);
    this.urlbar.addEventListener("keydown", this);

    // hover 提示: 地址栏默认不可见, tooltip 需补上 URL(前 100 字符)。
    // 捕获阶段: 活动 tab 上阻止 tooltip 显示; 冒泡阶段: 追加 URL。
    let mainPopupSet = this.window.document.getElementById("mainPopupSet");
    mainPopupSet?.addEventListener("popupshowing", this, true);
    mainPopupSet?.addEventListener("popupshowing", this);

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
      data == "browser.tabomnibar.overlay" ||
      data == "browser.tabomnibar.floatPos"
    ) {
      this.#readPrefs();
      if (this.#active) {
        this.exit();
      }
    } else if (data == "browser.tabomnibar.securityIndicator") {
      this.#securityIndicator = Services.prefs.getStringPref(
        "browser.tabomnibar.securityIndicator",
        "line"
      );
      this.#applySecurityIndicatorPref();
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
    this.#floatPos = Services.prefs.getStringPref(
      "browser.tabomnibar.floatPos",
      "follow"
    );
    this.#securityIndicator = Services.prefs.getStringPref(
      "browser.tabomnibar.securityIndicator",
      "line"
    );
    this.#applySecurityIndicatorPref();
  }

  #applySecurityIndicatorPref() {
    let tb = this.window.document.getElementById("TabsToolbar");
    if (tb) {
      tb.setAttribute("tabomnibar-security", this.#securityIndicator);
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "TabSelect":
        if (this.#active) {
          this.exit();
        }
        break;
      case "TabOpen": {
        let newTab = event.target;
        if (this.#active) {
          // 编辑态期间打开新 tab: 先退出当前编辑态(旧 tab 收缩成普通 tab),
          // 同时清除旧 tab 的延迟清理定时器, 避免干扰新 tab 的 enter。
          this.#pendingLayoutRefresh = true;
          event.stopImmediatePropagation();
          clearTimeout(this.#cleanupTimer);
          this.exit();
        }
        // 新 tab 打开后自动进入编辑态(展开成 urlbar)。
        // 延迟 80ms 确保旧 tab 退出动画已开始, 同一时刻最多两个 tab 在动画中。
        this.window.setTimeout(() => {
          this.maybeEnter(newTab);
        }, 80);
        break;
      }
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
          // 焦点移到 urlbar 内部子元素(搜索引擎按钮/下拉面板/清除按钮等)
          // 或 urlbar 下拉面板时, 不退出编辑态。
          let rel = event.relatedTarget;
          if (
            rel &&
            (this.urlbar.contains(rel) ||
              this.urlbarContainer.contains(rel) ||
              rel.closest?.(".urlbarView, .urlbarView-body-inner"))
          ) {
            break;
          }
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
          // 编辑态期间一律阻止 tooltip 显示(避免 hidePopup 后重新弹出)。
          if (this.#active) {
            event.preventDefault();
            return;
          }
          let tab = event.target.triggerNode?.closest?.("tab");
          if (event.eventPhase == Event.CAPTURING_PHASE) {
            // 捕获阶段(早于原生 createTooltip): 活动 tab 上阻止 tooltip 显示。
            if (tab && tab == this.window.gBrowser.selectedTab) {
              event.preventDefault();
            }
          } else if (tab && tab == this.window.gBrowser.selectedTab) {
            // 冒泡阶段(createTooltip 之后): 再次阻止, 确保 popup 不显示。
            event.preventDefault();
          } else if (
            tab &&
            !tab._overPlayingIcon &&
            !tab._overAudioButton
          ) {
            // 冒泡阶段(原生 createTooltip 已设置标题): 追加 URL(前 100 字符)。
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

    // 进入新编辑态前, 先清理上一次残留的压缩状态(避免连续开 tab 时 tab 宽度不一致)。
    this.#clearSqueezedTabs();

    this.#active = true;
    this.#activeTab = tab;
    this.#pendingLayoutRefresh = false;

    // 立即隐藏可能挡住地址栏的 tooltip。
    let tip = this.window.document.getElementById("tabbrowser-tab-tooltip");
    tip?.hidePopup();
    // 鼠标仍在 tab 上时, XUL 会在 hidePopup 后重新触发 popupshowing。
    // 用一个标记位让 popupshowing 监听器在编辑态期间一律 preventDefault。
        // 双保险: 直接给 tooltip 加 CSS 隐藏, 防止 XUL 内部路径绕过事件拦截。
    tip?.setAttribute("tabomnibar-hidden", "true");

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

    // 把 urlbarContainer 移到 tabContainer 末尾, 作为最后一个子元素。
    // 这样它在 DOM 顺序上排在所有 tab 之后, 自然渲染在最上面, 不需要依赖 z-index。
    this.#urlbarOriginalParent = urlbarContainer.parentNode;
    this.#urlbarOriginalNextSibling = urlbarContainer.nextSibling;
    container.appendChild(urlbarContainer);

    // 计算 tab 相对于 tabContainer 的位置, 用 absolute 定位对齐。
    let tabRect = tab.getBoundingClientRect();
    let containerRect = container.getBoundingClientRect();
    let left = tabRect.left - containerRect.left;
    let top = tabRect.top - containerRect.top;

    urlbarContainer.style.cssText =
      "display:block;position:absolute;top:" + top + "px;left:" + left +
      "px;bottom:0;z-index:100;padding:0;margin:0;width:" +
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
    if (this.#mode == "float" || this.#mode == "floatB" || this.#mode == "floatA") {
      if (this.#floatPos == "center") {
        // 永远显示在浏览器窗口水平中间。
        left =
          Math.round((this.window.innerWidth - FLOAT_WIDTH) / 2) -
          stripRect.left;
      } else {
        // 跟随激活 tab, 与 tab 左侧对齐。
        left = Math.round(tabRect.left - stripRect.left);
      }
    } else {
      // aligned: 左对齐激活 tab, 位于 tab 下方, 向右扩到浏览器右边界(留 16px 边距)。
      left = tabRect.left - stripRect.left;
      let maxW = this.window.innerWidth - 16 - tabRect.left;
      // 优先 480px, 但绝不越过右边界(极端贴右时缩窄)。
      width = Math.min(Math.max(FLOAT_WIDTH, maxW), maxW);
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
        let tip = this.window.document.getElementById("tabbrowser-tab-tooltip");
    tip?.removeAttribute("tabomnibar-hidden");

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

    this.#clearSqueezedTabs();

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
      // 退出后立即恢复 tab 宽度(不等动画结束), 避免新 tab 进入时残留压缩状态。
      this.#clearSqueezedTabs();
    } else {
      urlbarContainer.style.cssText = "";
      this.#squeezedTabs = [];
      this.#activeTab = null;
    }
  }

  /**
   * 清理所有被压缩 tab 的宽度样式, 恢复默认。
   */
  #clearSqueezedTabs() {
    for (let t of this.#squeezedTabs) {
      t.style.maxWidth = "";
      t.style.minWidth = "";
    }
    this.#squeezedTabs = [];
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

    let expandWidth = Math.min(
      TAB_OMNIBAR_MAX_WIDTH,
      Math.max(TAB_OMNIBAR_MIN_WIDTH, TAB_OMNIBAR_WIDTH)
    );
    expandWidth = Math.min(expandWidth, Math.max(viewport.width - 60, 160));
    this.activeWidth = expandWidth;

    // 不压缩任何 tab —— 所有 tab 的位置和宽度保持不变, 鼠标不漂移。
    // 地址栏用 absolute 定位向右溢出, 覆盖在右侧 tab 上方(z-index)。
    this.#squeezedTabs = [];
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
