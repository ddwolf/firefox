/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// TabOmnibar: 单击已选中标签页, 在其下方打开地址栏（Omnibar）。
// 复用全局单例 UrlbarInput（gURLBar），编辑态下传统地址栏（#nav-bar）完全折叠。
// 标签自身的尺寸和位置始终不变。
//
// 显示模式（browser.tabomnibar.mode）:
// - "floatA" (默认): 固定大小浮层; tab 自身不变。
// - "floatB": 固定大小浮层(与 floatA 行为一致, 保留名称兼容); tab 自身不变。
// - "aligned": 浮层左对齐激活 tab, 向右扩展到窗口右端, 位于 tab 下方; tab 自身不变。
// "in"（地址栏铺进 tab、tab 展开）已移除: 打开期间切换 tab 时, 各 tab 尺寸和位置会剧烈跳动。
// 旧配置里的 "in" 以及其他未知值按 "floatA" 处理。
// browser.tabomnibar.overlay: true=浮层与 tab 一平盖住 tab 栏; false=浮层位于 tab 栏下方。
// browser.tabomnibar.floatPos: float 浮层水平锚定; "follow"=与激活 tab 左侧对齐, "center"=窗口水平居中。

const FLOAT_WIDTH = 480;
const { STATE_IS_SECURE, STATE_IS_INSECURE, STATE_IS_BROKEN } =
  Ci.nsIWebProgressListener;

export class TabOmnibar {
  #container;
  #active = false;
  #activeTab = null;
  #pendingLayoutRefresh = false;
  #urlbarOriginalParent = null;
  #urlbarOriginalNextSibling = null;
  #mode = "floatA";
  #overlay = true;
  #floatPos = "follow";
  #securityIndicator = "line";

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
    this.#mode = this.#normalizeMode(
      Services.prefs.getStringPref("browser.tabomnibar.mode", "floatA")
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

  /**
   * "in" 会改写 tab 尺寸, 打开地址栏时切换 tab 会让整条标签栏跳动, 已移除。
   * 未知值和旧的 "float" 都落到 floatA。
   */
  #normalizeMode(mode) {
    switch (mode) {
      case "floatA":
      case "floatB":
      case "aligned":
        return mode;
      default:
        return "floatA";
    }
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
          // 编辑态期间打开新 tab: 先退出当前编辑态, 再让新 tab 进入。
          this.#pendingLayoutRefresh = true;
          event.stopImmediatePropagation();
          this.exit();
        }
        // 新 tab 打开后自动进入编辑态。
        // 延迟 80ms, 避免和上一个 tab 的退出叠在同一帧。
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
        if (this.#active) {
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
   * 在当前已选中 tab 下方打开地址栏。tab 自身不改变尺寸。
   */
  maybeEnter(tab) {
    IOUtils.write(
      "C:\\Users\\mycapital\\omnibar_layout.txt",
      new TextEncoder().encode(
        `maybeEnter: active=${this.#active} pinned=${tab.pinned} selected=${tab == this.window.gBrowser.selectedTab} mode=${this.#mode}\n`
      )
    ).catch(e => console.log("TOB dump:", e));
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

    // 立即隐藏可能挡住地址栏的 tooltip。
    let tip = this.window.document.getElementById("tabbrowser-tab-tooltip");
    tip?.hidePopup();
    // 鼠标仍在 tab 上时, XUL 会在 hidePopup 后重新触发 popupshowing。
    // 用一个标记位让 popupshowing 监听器在编辑态期间一律 preventDefault。
    // 双保险: 直接给 tooltip 加 CSS 隐藏, 防止 XUL 内部路径绕过事件拦截。
    tip?.setAttribute("tabomnibar-hidden", "true");

    // 新版 Tab Hover Preview(THP)面板不走 XUL tooltip 事件, 需单独关闭。
    let panel = this.#container.previewPanel;
    if (panel) {
      panel.deactivate();
      panel.forceReset?.();
    }

    this.#enterFloat(tab);

    this.gURLBar.setURI({ uri: tab.linkedBrowser.currentURI });
    this.gURLBar.focus();
    this.gURLBar.select();
  }

  #enterFloat(tab) {
    let { urlbar, urlbarContainer } = this;
    this.#urlbarOriginalParent = urlbarContainer.parentNode;
    this.#urlbarOriginalNextSibling = urlbarContainer.nextSibling;
    this.#floatStrip().appendChild(urlbarContainer);
    this.#applyFloatPosition(tab);
    urlbarContainer.setAttribute("tabomnibar-float", "");
    this.#container.setAttribute("tabomnibar-active", "");
    // 地址栏是独立浮层, 不改 tab 自身的尺寸和外观。
    urlbar.setAttribute("tabomnibar", "");
    this.#dumpLayout(tab, "enterFloat");
    let view = urlbar.querySelector(".urlbarView");
    let dumpAfter = () => {
      view.removeEventListener("popupshown", dumpAfter);
      this.window.setTimeout(() => this.#dumpLayout(tab, "popover-open"), 100);
    };
    view.addEventListener("popupshown", dumpAfter);
  }

  #dumpLayout(tab, tag) {
    try {
      let r = el => {
        let b = el?.getBoundingClientRect();
        return b
          ? `l=${Math.round(b.left)} t=${Math.round(b.top)} r=${Math.round(b.right)} b=${Math.round(b.bottom)} w=${Math.round(b.width)} h=${Math.round(b.height)}`
          : "null";
      };
      let cs = el => (el ? getComputedStyle(el) : null);
      let urlbar = this.urlbar;
      let view = urlbar.querySelector(".urlbarView");
      let viewBg = urlbar.querySelector(".urlbarView-background");
      let urlbarBg = urlbar.querySelector(".urlbar-background");
      let out = [
        `=== TabOmnibar dump [${tag}] mode=${this.#mode} overlay=${this.#overlay} floatPos=${this.#floatPos} ===`,
        `strip: ${r(this.#floatStrip())}`,
        `tab: ${r(tab)}`,
        `urlbarContainer: ${r(this.urlbarContainer)}`,
        `urlbarContainer.style: ${this.urlbarContainer.style.cssText}`,
        `urlbarContainer.computed top: ${cs(this.urlbarContainer).top} position: ${cs(this.urlbarContainer).position} transform: ${cs(this.urlbarContainer).transform} margin: ${cs(this.urlbarContainer).margin}`,
        `urlbar: ${r(urlbar)}`,
        `  urlbarBg: ${r(urlbarBg)}`,
        `  urlbarBg.radius: ${cs(urlbarBg).borderRadius}`,
        `  urlbarBg.bg: ${cs(urlbarBg).backgroundColor}`,
        `  urlbarBg.insetInline: ${cs(urlbarBg).insetInline}`,
        `  urlbarBg.insetBlock: ${cs(urlbarBg).insetBlock}`,
        `view: ${r(view)}`,
        `  viewBg: ${r(viewBg)}`,
        `  viewBg.radius: ${cs(viewBg).borderRadius}`,
        `  viewBg.bg: ${cs(viewBg).backgroundColor}`,
        `  viewBg.insetInline: ${cs(viewBg).insetInline}`,
        `  viewBg.insetBlock: ${cs(viewBg).insetBlock}`,
        `  viewBg.clipPath: ${cs(viewBg).clipPath}`,
        `urlbar.open: ${urlbar.hasAttribute("popover-open")} focused: ${urlbar.hasAttribute("focused")}`,
        `tabs with active: ${[...this.#container.querySelectorAll(".tabbrowser-tab[tabomnibar-active]")].map(t => t._tPos).join(",")}`,
      ].join("\n");
      IOUtils.write("C:\\Users\\mycapital\\omnibar_layout.txt", new TextEncoder().encode(out)).catch(e =>
        console.log("TOB dump write:", e)
      );
    } catch (e) {
      console.log("TOB dump failed:", e);
    }
  }

  #applyFloatPosition(tab) {
    let { left, top, width } = this.#floatLayout(tab);
    this.urlbarContainer.style.cssText =
      "display:block;position:absolute;left:" +
      left +
      "px;top:" +
      top +
      "px;width:" +
      width +
      "px;z-index:100;padding:0;margin:0;box-sizing:border-box;";
  }

  #floatLayout(tab) {
    let strip = this.#floatStrip();
    let tabRect = tab.getBoundingClientRect();
    let stripRect = strip.getBoundingClientRect();
    let height = stripRect.height;
    let left;
    let width = FLOAT_WIDTH;
    if (this.#mode == "floatA" || this.#mode == "floatB") {
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

    let { urlbar, urlbarContainer } = this;
    let container = this.#container;
    let strip = this.#floatStrip();

    urlbar.removeAttribute("tabomnibar");
    urlbarContainer.removeAttribute("tabomnibar-float");
    container.removeAttribute("tabomnibar-active");
    strip.removeAttribute("tabomnibar-float");
    strip.removeAttribute("tabomnibar-mode");
    strip.removeAttribute("tabomnibar-overlay");

    if (this.#urlbarOriginalParent) {
      this.#urlbarOriginalParent.insertBefore(
        urlbarContainer,
        this.#urlbarOriginalNextSibling
      );
    }
    this.#urlbarOriginalParent = null;
    this.#urlbarOriginalNextSibling = null;

    urlbarContainer.style.cssText = "";
    this.#activeTab = null;
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
