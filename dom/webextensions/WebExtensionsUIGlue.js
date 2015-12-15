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
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMGlobalPropertyInitializer]),

  init: function(window) {
    this.window = window;
    this.listeners = new WeakMap();
  },

  // WebExtensionsUIGlue
  registerAPI: function(api) {
    Management.registerAPI((extension, context) => {
      let a = api(wrapExtension(this.window, extension), wrapContext(this.window, context));
      if (a.wrappedJSObject.browserAction)
      dump("register api result > "+a.wrappedJSObject.browserAction+" / "+a.wrappedJSObject.browserAction.wrappedJSObject+"\n");
      return a.wrappedJSObject;
    });
  },

  registerWebIDLImplementation(name, impl) {
    let classID = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator).generateUUID();
    let classDescription = "JS WebIDL";
    let contractID;
    if (name == "WebExtensionBrowserAction")
      contractID = "@mozilla.org/webextensions/browserAction;1";
    else if (name == "WebExtensionTabs")
      contractID = "@mozilla.org/webextensions/tabs;1";
    else if (name == "WebExtensionEventListener")
      contractID = "@mozilla.org/webextensions/eventListener;1";

    let cls = impl;
    const factory = {
      createInstance: function(outer, iid) {
        if (outer) {
          throw Cr.NS_ERROR_NO_AGGREGATION;
        }
        return new cls();
      }
    };
    let Cm = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    Cm.registerFactory(classID, classDescription, contractID, factory);
  },

  registerPrivilegedAPI(permission, api) {
    // TODO
  },

  on: function(type, callback) {
    if (type == "manifest_browser_action") {
      let listener = (type, directive, extension, manifest) => {
        callback(type, directive, wrapExtension(this.window, extension), Cu.cloneInto(manifest, this.window));
      };
      Management.on(type, listener);
      this.listeners.set(callback, listener);
    } else if (type == "shutdown") {
      let listener = (type, extension) => {
        callback(wrapExtension(this.window, extension));
      };
      Management.on(type, listener);
      this.listeners.set(callback, listener);
    } else {
      throw new Error("Not implemented");
    }
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
