/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This XPCOM component is loaded very early during Firefox startup.
 * It manage the devtools addon installation and update.
 * It registers into Firefox UI (key shortcut and menus) in order to
 * ease the installation of DevTools add-on.
 *
 * Be careful to lazy load dependencies as much as possible.
 **/

"use strict";

const { interfaces: Ci, utils: Cu } = Components;

const { XPCOMUtils } = Cu.import("resource://gre/modules/XPCOMUtils.jsm", {});
const { Services } = Cu.import("resource://gre/modules/Services.jsm", {});

XPCOMUtils.defineLazyModuleGetter(this, "AddonManager", "resource://gre/modules/AddonManager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CustomizableUI", "resource:///modules/CustomizableUI.jsm");

const isMac = Services.appinfo.OS === "Darwin";

// List of all command line arguments supported by DevTools that must trigger
// add-on installation
const DevToolsFlags = [
  "jsconsole",
  "jsdebugger",
  "devtools",
  "start-debugger-server",
];

// List of all key shortcuts triggering installation UI
const modifiers = isMac ? "accel,alt" : "accel,shift";
// `id` should match tool's id from client/definitions.js
const KeyShortcuts = [
  { // hi-IN: एल, kk: a
    id: "toogleToolbox",
    shortcut: "I",
    modifiers
  },
  { // All locales are using F12
    id: "toogleToolboxF12",
    shortcut: "VK_F12",
    modifiers: "" // F12 is the only one without modifiers
  },
  { // kk: K, el: 0, sk: r, eo: I, cy: A
    id: "inspector",
    shortcut: "C",
    modifiers
  },
  { // kk: л
    id: "webconsole",
    shortcut: "K",
    modifiers
  },
  { // eu: t, el: Σ
    id: "jsdebugger",
    shortcut: "S",
    modifiers
  },
];

// ID defined in add-on's install.rdf file
const AddonID = "devtools@mozilla.org";

function DevToolsStartup() {
}

DevToolsStartup.prototype = {
  // Returns true if Firefox was ran with any command line argument specific
  // to DevTools
  hasAnyDevToolsFlag(cmdLine) {
    for (let flag of DevToolsFlags) {
      if (cmdLine.findFlag(flag, false) != -1) {
        return true;
      }
    }
    return false;
  },

  // Returns true if the DevTools add-on is installed *and* enabled
  get isInstalled() {
    return new Promise(resolve => {
      AddonManager.getAddonByID(AddonID, addon => {
        resolve(addon && !addon.userDisabled);
      });
    });
  },

  // Returns true if DevTools toolbox has been opened at least once for this
  // profile
  get hasDevToolsEverBeenOpened() {
    // This telemetry pref is updated whenever we open the toolbox
    return Services.prefs.prefHasUserValue("devtools.telemetry.tools.opened.version");
  },

  // Returns true if we should try to automatically install the add-on
  get autoInstallEnabled() {
    return Services.prefs.getBoolPref("devtools.addon.auto-install");
  },

  // Returns the xpi file URL
  get addonURL() {
    return Services.prefs.getCharPref("devtools.addon.install-url");
  },

  // Execute early during Firefox startup to process command line arguments.
  // But here, this is also the very first startup codepath for DevTools shim.
  async handle(cmdLine) {
    let isInstalled = await this.isInstalled;

    // If the add-on is already installed, its own command line component is
    // going to take over. Register into Firefox UI and implement the command
    // line arguments
    if (isInstalled) {
      dump("Add-on already installed\n");
      return;
    }

    dump("Auto install enabled: " + this.autoInstallEnabled + "\n");
    dump("Has any devtools command line argument: " + this.hasAnyDevToolsFlag(cmdLine) + "\n");
    dump("Has devtools ever been opened: " + this.hasDevToolsEverBeenOpened + "\n");
    if (this.autoInstallEnabled && (this.hasAnyDevToolsFlag(cmdLine) || this.hasDevToolsEverBeenOpened)) {
      dump("Install DevTools\n");
      this.install();
    } else {
      Services.obs.addObserver(this, "browser-delayed-startup-finished");
      Services.obs.addObserver(this, "browser-inspect-node");
      let listener = {};
      listener.onEnabled =
      listener.onDisabled =
      listener.onInstalled =
      listener.onUninstalled = addon => {
        this.isInstalled.then(installed => {
          if (installed) {
            this.cleanup();
          }
        });
      };
      this.addonListener = listener;
      AddonManager.addAddonListener(listener);
    }
  },

  cleanup() {
    Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    Services.obs.removeObserver(this, "browser-inspect-node");
    AddonManager.removeAddonListener(this.addonListener);
    let windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      let doc = windows.getNext().document;
      // Remove all existing keysets
      let keyset = doc.getElementById("DevToolsShimKeyset");
      if (keyset) {
        keyset.remove();
      }
      // Remove the Tools menu item
      let menu = doc.getElementById("DevToolsInstallMenu");
      if (menu) {
        menu.remove();
      }
    }
    CustomizableUI.removeWidgetFromArea("developer-button");
    CustomizableUI.destroyWidget("developer-button");

    dump("cleaned up\n");
  },

  observe(subject, topic) {
    switch (topic) {
      case "browser-delayed-startup-finished":
        this.hookKeys(subject);
        this.hookToolsMenu(subject);
        this.hookHamburgerMenu();
        break;
      case "browser-inspect-node":
        break;
    }
  },

  install() {
    // >>> DO NOT LAND THAT
    // TODO: sign the addon via AMO for 56 or "Mozilla Extension" for 57
    Services.prefs.setBoolPref("xpinstall.signatures.required", false);
    // TODO: Flag the addon as multiple processes compatible (<em:multiprocessCompatible>true</em:multiprocessCompatible> in install.rdf)
    Services.prefs.setBoolPref("extensions.allow-non-mpc-extensions", true);
    // <<< DO NOT LAND THAT

    return new Promise((resolve, reject) => {
      let installFailureHandler = (install, message) => {
        dump("Install failure: " + message + "\n");
        reject(message);
      };
      let listener = {
        onDownloadStarted() {
          this.status = "downloading";
          dump("Downloading\n");
        },

        onInstallStarted() {
          this.status = "installing";
          dump("Installing\n");
        },

        onDownloadProgress(install) {
          let progress = install.maxProgress == -1 ? -1 :
            install.progress / install.maxProgress;
          dump("Progress: " + progress + "\n");
        },

        onInstallEnded({addon}) {
          addon.userDisabled = false;
          dump("Installed!\n");
          resolve();
        },

        onDownloadCancelled(install) {
          installFailureHandler(install, "Download cancelled");
        },
        onDownloadFailed(install) {
          installFailureHandler(install, "Download failed");
        },
        onInstallCancelled(install) {
          installFailureHandler(install, "Install cancelled");
        },
        onInstallFailed(install) {
          installFailureHandler(install, "Install failed");
        },
      };
      AddonManager.getInstallForURL(this.addonURL, install => {
        install.addListener(listener);
        install.install();
      }, "application/x-xpinstall");
    });
  },

  // Register various common DevTools keyshortcut to trigger the install dialog
  hookKeys(window) {
    let doc = window.document;
    let keyset = doc.createElement("keyset");
    keyset.setAttribute("id", "DevToolsShimKeyset");

    for (let key of KeyShortcuts) {
      let xulKey = this.createKey(doc, key,
        this.showInstallDialog.bind(this, "key", key));
      keyset.appendChild(xulKey);
    }

    // Appending a <key> element is not always enough. The <keyset> needs
    // to be detached and reattached to make sure the <key> is taken into
    // account (see bug 832984).
    let mainKeyset = doc.getElementById("mainKeyset");
    mainKeyset.parentNode.insertBefore(keyset, mainKeyset);
  },

  // Create a <xul:key> DOM Element
  createKey(doc, { id, shortcut, modifiers: mod }, oncommand) {
    let k = doc.createElement("key");
    k.id = "key_" + id;

    if (shortcut.startsWith("VK_")) {
      k.setAttribute("keycode", shortcut);
    } else {
      k.setAttribute("key", shortcut);
    }

    if (mod) {
      k.setAttribute("modifiers", mod);
    }

    // Bug 371900: command event is fired only if "oncommand" attribute is set.
    k.setAttribute("oncommand", ";");
    k.addEventListener("command", oncommand);

    return k;
  },

  // Add a menu entry in Tool menu to trigger the install dialog
  hookToolsMenu(window) {
    let doc = window.document;
    let item = this.createMenuItem(doc, {
      id: "DevToolsInstallMenu",
      label: "Enable Developer Tools"
    });
    item.addEventListener("command", this.showInstallDialog.bind(this, "menu"));
    let menu = doc.getElementById("menuWebDeveloperPopup");
    menu.appendChild(item);
  },

  // Create a <xul:menuitem> DOM Element
  createMenuItem(doc, { id, label, accesskey }) {
    let menuitem = doc.createElement("menuitem");
    menuitem.id = id;
    menuitem.setAttribute("label", label);
    if (accesskey) {
      menuitem.setAttribute("accesskey", accesskey);
    }
    return menuitem;
  },

  hookHamburgerMenu() {
    let id = "developer-button";
    let widget = CustomizableUI.getWidget(id);
    if (widget && widget.provider == CustomizableUI.PROVIDER_API) {
      return;
    }
    CustomizableUI.createWidget({
      id,
      shortcutId: "key_toogleToolbox",
      viewId: "PanelUI-developer",
      tooltiptext: "developer-button.tooltiptext2",
      defaultArea: CustomizableUI.AREA_PANEL,
      onCommand: this.showInstallDialog.bind(this, "hamburger")
    });
  },

  async showInstallDialog(reason, options) {
    dump("Show shim UI!\n");
    // TODO: Move that code to its own jsm, to lazily load this code which is going to grow
    // and is not needed on Firefox startup.
    let title = "Do you want to open Developer Tools?";
    let message = "It looks like you want to use Developer Tools,\nDo you confirm this?\n";
    let win = Services.wm.getMostRecentWindow("navigator:browser");
    let ok = Services.prompt.confirm(win, title, message);
    if (ok) {
      await this.install();

      let { require } = Cu.import("resource://devtools/shared/Loader.jsm", {});
      let { gDevToolsBrowser } = require("devtools/client/framework/devtools-browser");
      if (reason == "menu" || reason == "hamburger" ||
          (reason == "key" &&
           (options.id == "toogleToolbox" || options.id == "toogleToolboxF12"))) {
        gDevToolsBrowser.toggleToolboxCommand(win.gBrowser);
      } else if (reason == "key") {
        gDevToolsBrowser.selectToolCommand(win.gBrowser, options.id);
      }
    }
  },

  /* eslint-disable max-len */
  helpInfo: "  --jsconsole        Open the Browser Console.\n" +
            "  --jsdebugger       Open the Browser Toolbox.\n" +
            "  --wait-for-jsdebugger Spin event loop until JS debugger connects.\n" +
            "                     Enables debugging (some) application startup code paths.\n" +
            "                     Only has an effect when `--jsdebugger` is also supplied.\n" +
            "  --devtools         Open DevTools on initial load.\n" +
            "  --start-debugger-server [ws:][ <port> | <path> ] Start the debugger server on\n" +
            "                     a TCP port or Unix domain socket path. Defaults to TCP port\n" +
            "                     6000. Use WebSocket protocol if ws: prefix is specified.\n",
  /* eslint-disable max-len */

  classID: Components.ID("{b8b0da42-30d3-11e7-9cf6-000c29036c20}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsICommandLineHandler]),
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DevToolsStartup]);
