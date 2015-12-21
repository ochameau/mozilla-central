/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;
const Ci = Components.interfaces;

// about: pages have broken location object and only href is set.
let params = {};
let search = window.location.href.split("?")[1];
if (search) {
  for(let kv of search.split("&")) {
    let [k, v] = kv.split("=");
    params[k] = decodeURIComponent(v);
  }
}

// `host` is the frame element (xul:browser or html:iframe) loading the toolbox
let host = window.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindowUtils)
                 .containerElement;

if (params["tab-id"]) {
  var topWindow = window.QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIWebNavigation)
                        .QueryInterface(Ci.nsIDocShellTreeItem)
                        .rootTreeItem
                        .QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIDOMWindow);
  if (topWindow && topWindow.gBrowser) {
    let tab = topWindow.gBrowser.tabs[parseInt(params["tab-id"]) - 1];
    if (tab) {
      loadTab(tab, host);
    } else {
      console.error("Unable to find tab #" + params["tab-id"]);
    }
  } else {
    console.error("Unable to retrieve top level firefox window from toolbox document");
  }
} else if (params["target"]) {
  // `iframe` is the targeted document to debug
  let iframe = host.wrappedJSObject.target;
  // Need to use an xray and query some interfaces to have
  // attributes and behavior expected by devtools codebase
  iframe = XPCNativeWrapper(iframe);
  iframe.QueryInterface(Ci.nsIFrameLoaderOwner);
  // Fake a xul:tab object as we don't have have.
  // linkedBrowser is the only one attribute being queried.
  let tab = { linkedBrowser: iframe };
  if (iframe) {
    loadTab(tab, host).
      then(() => host.removeAttribute("style"));
  } else {
    console.error("Missing `target` attribute on the toolbox iframe");
  }
}

function loadTab(tab, host) {
  const {gDevTools} = Cu.import("resource://devtools/client/framework/gDevTools.jsm", {});
  const {require} = Cu.import("resource://devtools/shared/Loader.jsm", {});
  const {Toolbox} = require("devtools/client/framework/toolbox");
  const {TargetFactory} = require("devtools/client/framework/target");
  const {DebuggerServer} = require("devtools/server/main");
  const {DebuggerClient} = require("devtools/shared/client/main");
  const promise = require("promise");

  // Setup a server if we don't have one already running
  if (!DebuggerServer.initialized) {
    DebuggerServer.init();
    DebuggerServer.addBrowserActors();
  }

  let client = new DebuggerClient(DebuggerServer.connectPipe());
  return client.connect()
    .then(() => client.getTab({ tab: tab }))
    .then(response =>
      TargetFactory.forRemoteTab({client, form: response.tab, chrome: false}))
    .then(target => {
      let options = {customIframe: host};
      return gDevTools.showToolbox(target, null, Toolbox.HostType.CUSTOM, options);
    });
}
