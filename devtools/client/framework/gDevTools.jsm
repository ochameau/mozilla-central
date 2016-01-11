/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = [ "gDevTools", "DevTools", "gDevToolsBrowser" ];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const {loader} = Cu.import("resource://devtools/shared/Loader.jsm", {});

/**
 * Do not directly map to the commonjs modules so that callsites of
 * gDevTools.jsm do not have to do anything to access to the very last version
 * of the module. The `devtools` and `browser` getter are always going to
 * retrieve the very last version of the modules.
 */
Object.defineProperty(this, "require", {
  get() {
    let {require} = Cu.import("resource://devtools/shared/Loader.jsm", {});
    return require;
  }
});
Object.defineProperty(this, "devtools", {
  get() {
    return require("devtools/client/framework/devtools");
  }
});
Object.defineProperty(this, "browser", {
  get() {
    return require("devtools/client/framework/browser");
  }
});

/**
 * gDevTools is a singleton that controls the Firefox Developer Tools.
 *
 * It is an instance of a DevTools class that holds a set of tools. It has the
 * same lifetime as the browser.
 */
this.gDevTools = {
  // Used by the reload addon.
  // Force reloading dependencies if the loader happens to have reloaded.
  reload() {},

  // Used by: - b2g desktop.js
  //          - nsContextMenu
  //          - /devtools code
  showToolbox(target, toolId, hostType, hostOptions) {
    return devtools.showToolbox(target, toolId, hostType, hostOptions);
  },

  // Used by Addon SDK and /devtools
  closeToolbox(target) {
    return devtools.closeToolbox(target);
  },
  getToolbox(target) {
    return devtools.getToolbox(target);
  },

  // Used by Addon SDK, main.js and tests:
  registerTool(toolDefinition) {
    devtools.registerTool(toolDefinition);
  },
  registerTheme(themeDefinition) {
    devtools.registerTheme(themeDefinition);
  },
  unregisterTool(tool, isQuitApplication) {
    devtools.unregisterTool(tool, isQuitApplication);
  },
  unregisterTheme(theme) {
    devtools.unregisterTheme(theme);
  },

  // Used by main.js and test
  getToolDefinitionArray() {
    return devtools.getToolDefinitionArray();
  },
  getThemeDefinitionArray() {
    return devtools.getThemeDefinitionArray();
  },

  // Used by theme-switching.js
  getThemeDefinition(themeId) {
    return devtools.getThemeDefinition(themeId);
  },
  emit(...args) {
    return devtools.emit.apply(devtools, args);
  },

  // Used by /devtools
  on(...args) {
    return devtools.on.apply(devtools, args);
  },
  off(...args) {
    return devtools.off.apply(devtools, args);
  },
  once(...args) {
    return devtools.once.apply(devtools, args);
  },

  // Used by tests
  getToolDefinitionMap() {
    return devtools.getToolDefinitionMap();
  },
  getThemeDefinitionMap() {
    return devtools.getThemeDefinitionMap();
  },
  getDefaultTools() {
    return devtools.getDefaultTools();
  },
  getAdditionalTools() {
    return devtools.getAdditionalTools();
  },
  getToolDefinition(toolId) {
    return devtools.getToolDefinition(toolId);
  },
  get _toolboxes() {
    return devtools._toolboxes;
  },
  get _tools() {
    return devtools._tools;
  },
  *[Symbol.iterator]() {
    for (let toolbox of this._toolboxes) {
      yield toolbox;
    }
  }
};

/**
 * gDevToolsBrowser exposes functions to connect the gDevTools instance with a
 * Firefox instance.
 */
this.gDevToolsBrowser = {
  // used by browser-sets.inc, command
  toggleToolboxCommand(gBrowser) {
    browser.toggleToolboxCommand(gBrowser);
  },

  // Used by browser.js itself, by setting a oncommand string...
  selectToolCommand(gBrowser, toolId) {
    return browser.selectToolCommand(gBrowser, toolId);
  },

  // Used by browser-sets.inc, command
  openConnectScreen(gBrowser) {
    browser.openConnectScreen();
  },

  // Used by browser-sets.inc, command
  //         itself, webide widget
  openWebIDE() {
    browser.openWebIDE();
  },

  // Used by browser-sets.inc, command
  openContentProcessToolbox() {
    browser.openContentProcessToolbox();
  },

  // Used by webide.js
  get isWebIDEInitialized() {
    return browser.isWebIDEInitialized;
  },

  // Used by webide.js
  moveWebIDEWidgetInNavbar() {
    browser.moveWebIDEWidgetInNavbar();
  },

  // Used by browser.js
  registerBrowserWindow(win) {
    browser.registerBrowserWindow(win);
  },

  // Used by reload addon
  hasToolboxOpened(win) {
    return browser.hasToolboxOpened();
  },

  // Used by browser.js
  forgetBrowserWindow(win) {
    browser.forgetBrowserWindow(win);
  },

  // Used by a test (should be removed)
  get _trackedBrowserWindows() {
    return browser._trackedBrowserWindows;
  }
};

// Load the browser devtools main module as the loader's main module.
loader.main("devtools/client/main");
