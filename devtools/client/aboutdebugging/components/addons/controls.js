/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env browser */
/* globals AddonManager */

"use strict";

loader.lazyImporter(this, "AddonManager",
  "resource://gre/modules/AddonManager.jsm");

const { Cc, Ci, components } = require("chrome");
const { createFactory, createClass, DOM: dom } =
  require("devtools/client/shared/vendor/react");
const Services = require("Services");
const AddonsInstallError = createFactory(require("./install-error"));

loader.lazyRequireGetter(this, "watchFiles", "devtools/client/shared/file-watcher", true);
loader.lazyImporter(this, "OS", "resource://gre/modules/osfile.jsm");
loader.lazyImporter(this, "NetUtil", "resource://gre/modules/NetUtil.jsm");
loader.lazyImporter(this, "FileUtils", "resource://gre/modules/FileUtils.jsm");
loader.lazyGetter(this, "DOMUtils", () => {
  return Cc["@mozilla.org/inspector/dom-utils;1"].getService(Ci.inIDOMUtils);
});

const Strings = Services.strings.createBundle(
  "chrome://devtools/locale/aboutdebugging.properties");

const MORE_INFO_URL = "https://developer.mozilla.org/docs/Tools" +
                      "/about:debugging#Enabling_add-on_debugging";

module.exports = createClass({
  displayName: "AddonsControls",

  getInitialState() {
    return {
      installError: null,
    };
  },

  onEnableAddonDebuggingChange(event) {
    let enabled = event.target.checked;
    Services.prefs.setBoolPref("devtools.chrome.enabled", enabled);
    Services.prefs.setBoolPref("devtools.debugger.remote-enabled", enabled);
  },

  loadAddonFromFile() {
    this.setState({ installError: null });
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window,
      Strings.GetStringFromName("selectAddonFromFile2"),
      Ci.nsIFilePicker.modeOpen);
    let res = fp.show();
    if (res == Ci.nsIFilePicker.returnCancel || !fp.file) {
      return;
    }
    let file = fp.file;
    // AddonManager.installTemporaryAddon accepts either
    // addon directory or final xpi file.
    if (!file.isDirectory() && !file.leafName.endsWith(".xpi")) {
      file = file.parent;
    }

    AddonManager.installAddonFromSources(file)
      .catch(e => {
        console.error(e);
        this.setState({ installError: e.message });
      })
      .then(() => {
        if (file.isDirectory()) {
          this.tryHookingHotreload(file);
        }
      });
  },

  render() {
    let { debugDisabled } = this.props;

    return dom.div({ className: "addons-top" },
      dom.div({ className: "addons-controls" },
        dom.div({ className: "addons-options" },
          dom.input({
            id: "enable-addon-debugging",
            type: "checkbox",
            checked: !debugDisabled,
            onChange: this.onEnableAddonDebuggingChange,
          }),
          dom.label({
            className: "addons-debugging-label",
            htmlFor: "enable-addon-debugging",
            title: Strings.GetStringFromName("addonDebugging.tooltip")
          }, Strings.GetStringFromName("addonDebugging.label")),
          "(",
          dom.a({ href: MORE_INFO_URL, target: "_blank" },
            Strings.GetStringFromName("moreInfo")),
          ")"
        ),
        dom.button({
          id: "load-addon-from-file",
          onClick: this.loadAddonFromFile,
        }, Strings.GetStringFromName("loadTemporaryAddon"))
      ),
      AddonsInstallError({ error: this.state.installError }));
  },

  tryHookingHotreload(folder) {
    let manifest = folder.clone();
    manifest.append("chrome.manifest");
    if (!manifest.exists()) {
      return;
    }
    this.readFile(manifest.path).then(data => {
      let mappings = {};
      let lines = data.split(/\n/);
      let entry = /^\s*(content|resource|skin)\s+(\S+)\s+(\S+)\s*(\S+)?\s*/;
      for (let line of lines) {
        let match = entry.exec(line);
        if (match) {
          let type = match[1];
          let name = match[2];
          let path = match[3];
          let url;
          if (type == "content") {
            url = "chrome://" + name + "/content";
          } else if (type == "skin") {
            url = "chrome://" + name + "/skin";
            // match[3] ends up being the skin name
            path = match[4];
          } else if (type == "resource") {
            url = "resource://" + name;
          } else {
            continue;
          }
          mappings[url] = OS.Path.normalize(OS.Path.join(folder.path, path));
        }
      }
      dump("Addon file mapping: " + JSON.stringify(mappings, null, 2)+"\n");
      this.watchAndReload(mappings).start();
    });
  },

  watchAndReload(mappings) {
    let stylesheets = {};

    let onFileUpdated = path => {
      dump("File updated: "+path+"\n");
      let stylesheet = stylesheets[path];
      if (stylesheet) {
        this.readFile(path).then(data => {
          DOMUtils.parseStyleSheet(stylesheet, data);
          dump("CSS updated.\n");
        });
      }
    };

    for (let prefix in mappings) {
      stylesheets[prefix] = [];
      let path = mappings[prefix];
      watchFiles(path, onFileUpdated);
    }

    let listener = event => {
      let url = event.stylesheet.href;
      if (!url) return;
      dump("New style sheet from: "+event.target.location+" url="+url+"\n");
      for (let prefix in mappings) {
        if (url.startsWith(prefix)) {
          let path = url.replace(prefix, mappings[prefix]);
          // Normalize path on windows:
          if (Services.appinfo.OS == "WINNT") {
            path = path.replace(/\//g, "\\");
          }
          dump("style sheet available at: "+path+"\n");
          stylesheets[path] = event.stylesheet;
        }
      }
    };

    let observer = function (window, topic, data) {
      dump("New top level document: "+window.location+" topic:"+topic+"\n");
      if (topic === "domwindowopened" ||
          topic === "chrome-document-global-created" ||
          topic == "load") {
        // about:blank document may be replaced with a new document without firing a new
        // chrome-document-global-created
        if (!window.location.href || window.location == "about:blank") {
          window.addEventListener("DOMContentLoaded", function onLoad() {
            window.removeEventListener("DOMContentLoaded", onLoad);
            observer(window, "load", null);
          }, true);
          return;
        }
        // Register already loaded stylesheets
        for (let s of window.document.styleSheets) {
          listener({stylesheet: s, target:window.document});
        }
        // But also listen for new ones
        window.document.styleSheetChangeEventsEnabled = true;
        window.addEventListener("StyleSheetAdded", listener, true);
      } else {
        window.document.styleSheetChangeEventsEnabled = false;
        window.removeEventListener("StyleSheetAdded", listener);
      }
    };

    return {
      start: function () {
        // Automatically process already opened windows
        let e = Services.ww.getWindowEnumerator();
        while (e.hasMoreElements()) {
          let window = e.getNext();
          observer(window, "domwindowopened", null);
        }
        // And listen for new ones to come
        Services.ww.registerNotification(observer);
        Services.obs.addObserver(observer, "chrome-document-global-created", false);
      },

      stop: function () {
        Services.ww.unregisterNotification(observer);
        Services.obs.removeObserver(observer, "chrome-document-global-created", false);
        let e = Services.ww.getWindowEnumerator();
        while (e.hasMoreElements()) {
          let window = e.getNext();
          observer(window, "domwindowclosed", null);
        }
      }
    };
  },

  readFile(path) {
    return new Promise((resolve, reject) => {
      let file = new FileUtils.File(path);
      NetUtil.asyncFetch({
        uri: NetUtil.newURI(file),
        loadUsingSystemPrincipal: true
      }, (inputStream, status) => {
        if (!components.isSuccessCode(status)) {
          reject(new Error("Couldn't load manifest: " + filename + "\n"));
          return;
        }
        var data = NetUtil.readInputStreamToString(inputStream, inputStream.available());
        resolve(data);
      });
    });
  },

});
