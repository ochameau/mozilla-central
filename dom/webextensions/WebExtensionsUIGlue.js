/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const {XPCOMUtils} = Cu.import("resource://gre/modules/XPCOMUtils.jsm", {});
const {Management, Extension} = Cu.import("resource://gre/modules/Extension.jsm", {});
const {injectAPI} = Cu.import("resource://gre/modules/ExtensionUtils.jsm", {});

const extensions = new WeakMap();
function wrapExtension(window, extension) {
  if (extensions.has(extension)) {
    return extensions.get(extension);
  }
  extension.baseURL = new window.URL(extension.baseURI.spec);
  let idlObject = window.WebExtension._create(window, extension);
  extensions.set(extension, idlObject);
  return idlObject;
}

function wrapContext(window, context) {
  let o = Cu.createObjectIn(window)
  o.callOnClose = Cu.exportFunction(context.callOnClose.bind(context), window);
  o.forgetOnClose = Cu.exportFunction(context.forgetOnClose.bind(context), window);
  o.contentWindow = context.contentWindow;
  dump(" context keys > "+context.contentWindow+"\n");
  o.construct = (name, impl) => {
    let v = window[name]._create(context.contentWindow, impl.wrappedJSObject);
    dump(" v = "+v+"\n");
    return v;
  }
  return o;
}

function WebExtensionsUIGlue() {
};

WebExtensionsUIGlue.prototype = {
  classID: Components.ID("{b7bcd9e4-9cf8-11e5-a117-28d2444736c9}"),
  contractID: "@mozilla.org/webextensions/ui-glue;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),

  // WebExtensionsUIGlue
  registerAPI: function(api) {
  },

  on: function(type, callback) {
  },

  off: function(type, callback) {
    let listener = this.listeners.get(callback);
    if (listener) {
      Management.off(type, listener);
      this.listeners.delete(callback);
    }
  },

  instanciateAddon(id, manifest) {
    let extension = {
      hasPermission() { return true; },
      manifest: manifest
    };
    dump("instanciate id "+id+" - "+manifest+"\n");
    extension = Extension.generate(id, {manifest: JSON.parse(JSON.stringify(manifest))});
    extension.startup();
    dump(">>> "+JSON.stringify(extension.manifest)+"\n");

    let context = {
      callOnClose(obj) {},
      forgetOnClose(obj) {},
      messenger: {
        onConnect() {},
        onMessage() {}
      },
      cloneScope: this.window
    };

    let chromeObj = Cu.createObjectIn(this.window);
    let api = Management.generateAPIs(extension, context, Management.apis);
    injectAPI(api, chromeObj);
    return chromeObj;
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([WebExtensionsUIGlue]);
