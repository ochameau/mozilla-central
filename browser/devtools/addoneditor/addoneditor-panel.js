/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {Cc, Ci, Cu, Cr} = require("chrome");

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/devtools/gDevTools.jsm");
const {TextEncoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {});

let {Promise: promise} = Cu.import("resource://gre/modules/Promise.jsm", {});

loader.lazyGetter(this, "StyleEditorPanel", () => require("devtools/styleeditor/styleeditor-panel").StyleEditorPanel);
loader.lazyGetter(this, "ScratchpadPanel", () => require("devtools/scratchpad/scratchpad-panel").ScratchpadPanel);
loader.lazyGetter(this, "AppManager", () => require("devtools/webide/app-manager").AppManager);

let addon = null;
this.AddonEditorPanel = function AddonEditorPanel(panelWin, toolbox) {
  addon = this;
  EventEmitter.decorate(this);

  this._toolbox = toolbox;
  this._target = toolbox.target;
  this._panelWin = panelWin;
  this._panelDoc = panelWin.document;

  this._styleFrame = this._panelDoc.getElementById("style");
  this._jsFrame = this._panelDoc.getElementById("js");

  // Create a promise that resolves only when both iframe are fully loaded
  let deferred = promise.defer();
  this._framesLoaded = deferred.promise;
  let count = 0;
  let onIframeLoad = () => {
    if (++count == 2) {
      this._jsFrame.removeEventListener("load", onIframeLoad);
      this._styleFrame.removeEventListener("load", onIframeLoad);
      deferred.resolve();
    }
  };
  this._jsFrame.addEventListener("load", onIframeLoad, true);
  this._styleFrame.addEventListener("load", onIframeLoad, true);

  this._updateCurrentURL = this._updateCurrentURL.bind(this);
  this._target.on("will-navigate", this._updateCurrentURL);
  this.destroy = this.destroy.bind(this);
}

exports.AddonEditorPanel = AddonEditorPanel;

function saveFile(text, path) {
  let encoder = new TextEncoder();
  let buffer = encoder.encode(text);
  return OS.File.writeAtomic(path, buffer, {tmpPath: path + ".tmp"});
}

AddonEditorPanel.prototype = {
  get target() this._toolbox.target,

  get panelWindow() this._panelWin,

  _updateCurrentURL: function (_, event) {
    this._currentURL = event.newURI;
  },

  promptFolder: function() {
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.defaultString = "addon";
    fp.init(this.panelWindow, "Select directory where to create app directory", Ci.nsIFilePicker.modeGetFolder);
    let res = fp.show();
    if (res == Ci.nsIFilePicker.returnCancel) {
      console.error("No directory selected");
      return;
    }
    return fp.file.path;
  },

  save: function () {
    let folder = this.promptFolder();
    if (!folder) {
      return;
    }

    let editor = this._stylePanel.UI.selectedEditor;
    let cssText = editor.sourceEditor.getText();
    let jsText = this._jsPanel.scratchpad.getText();

    if (cssText.length > 0) {
      saveFile(cssText, OS.Path.join(folder, "addon.css"));
    }
    if (jsText.length > 0) {
      saveFile(jsText, OS.Path.join(folder, "addon.js"));
    }

    let appLocation = this._target.url;
    let appType = AppManager.selectedProject ? AppManager.selectedProject.app.manifest.type : "web";
    let manifest = {
      name: "Addon",
      description: "Your addon",
      customizations: [
        {
          filter: appLocation,
          css: ["addon.css"],
          scripts: ["addon.js"]
        }
      ],
      type: appType,
      role: "addon"
    };
    saveFile(JSON.stringify(manifest, null, 2),
             OS.Path.join(folder, "manifest.webapp"));
  },

  open: function() {
    let saveBtn = this._panelDoc.getElementById("ae-toolbar-save");
    saveBtn.addEventListener("click", this.save.bind(this));

    return this._framesLoaded.then(() => {
      this._stylePanel = new StyleEditorPanel(this._styleFrame.contentWindow, this._toolbox);
      this._styleFrame.contentDocument.querySelector(".splitview-controller").style.visibility = "collapse";

      this._jsPanel = new ScratchpadPanel(this._jsFrame.contentWindow, this._toolbox);
      this._jsFrame.contentDocument.getElementById("sp-toolbar").style.visibility = "collapse";
      return this._stylePanel.open({ doNotLoadExistings: true })
                 .then(() => this._jsPanel.open())
    });
  },

  destroy: function() {
    if (!this._destroyed) {
      this._destroyed = true;

      this._target.off("close", this.destroy);
      this._target.off("will-navigate", this._updateCurrentURL);
      this._target = null;
      this._toolbox = null;
      this._panelDoc = null;
    }

    return promise.resolve(null);
  },
}

/*
XPCOMUtils.defineLazyGetter(AddonEditorPanel.prototype, "strings",
  function () {
    return Services.strings.createBundle(
            "chrome://browser/locale/devtools/styleeditor.properties");
  });
*/
