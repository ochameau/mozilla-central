/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Augment <iframe mozbrowser> to better work with existing web extension codebase.
 *
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Services.jsm");

let AddonPathService = Cc["@mozilla.org/addon-path-service;1"].getService(Ci.amIAddonPathService);

var EXPORTED_SYMBOLS = ["startup", "shutdown"];

function onNewIframe(subject, topic, data) {
  let frameLoader = subject;
  frameLoader.QueryInterface(Ci.nsIFrameLoader);
  let frame = frameLoader.ownerElement;
  // Only take care of HTML iframes
  if (frame.tagName != "IFRAME" || !frame.getAttribute("mozbrowser")) {
    return;
  }
  let { messageManager } = frame.QueryInterface(Ci.nsIFrameLoaderOwner).frameLoader;
  if (!messageManager) {
    return;
  }

  // Add messageManager attribute to mozbrowser iframes for webextensions
  frame.messageManager = messageManager;

  // Add innerWindowID attribute to mozbrowser iframes for webextensions
  messageManager.addMessageListener("browserui:innerWindowID", function listener({ data }) {
    dump("\n ++ receive window id: "+data.innerWindowID+" // "+data.outerWindowID+"\n\n");
    frame.innerWindowID = data.innerWindowID;
    frame.linkedBrowser = { innerWindowID: data.innerWindowID };
  });
  messageManager.loadFrameScript("data:,new " + function () {
    function update() {
      let innerWindowID = content.QueryInterface(Ci.nsIInterfaceRequestor)
                                 .getInterface(Ci.nsIDOMWindowUtils)
                                 .currentInnerWindowID;
      let outerWindowID = content.QueryInterface(Ci.nsIInterfaceRequestor)
                                 .getInterface(Ci.nsIDOMWindowUtils)
                                 .outerWindowID;
      sendAsyncMessage("browserui:innerWindowID", { innerWindowID, outerWindowID });
    }
    let listener = {
      onLocationChange(webProgress, request, locationURI, flags) {
        if (webProgress && webProgress.isTopLevel) {
          update();
        }
      },
      onProgressChange() {},
      onProgressChange64() {},
      onRefreshAttempted() { return true; },
      onSecurityChange() {},
      onStateChange() {},
      onStatusChange() {},
      QueryInterface: function QueryInterface(iid) {
        if (iid.equals(Ci.nsIWebProgressListener) ||
            iid.equals(Ci.nsISupportsWeakReference) ||
            iid.equals(Ci.nsISupports)) {
          return this;
        }
      }
    };
    let webProgress = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                              .getInterface(Ci.nsIWebProgress);
    webProgress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_ALL);
    addEventListener("unload", function () {
      let webProgress = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIWebProgress);
      webProgress.removeProgressListener(listener);
    });
    update();
  }, true);

  // Adds the browser API permission to web extension documents
  if (frame.src.includes("moz-extension:")) {
    let uri = Services.io.newURI(frame.src, null, null);
    let perms = [
      "browser",
    ];
    perms.forEach(name => {
      Services.perms.add(uri, name, Ci.nsIPermissionManager.ALLOW_ACTION);
      let { originAttributes } = frameLoader.loadContext;
      // Keep the same originAttributes and only add the addonId
      // (we want to keep all other origin attributes as-is)
      let addonId = AddonPathService.mapURIToAddonId(uri);
      originAttributes.addonId = addonId;
      let principal = Services.scriptSecurityManager.createCodebasePrincipal(uri, originAttributes); 
      Services.perms.addFromPrincipal(principal, name, Ci.nsIPermissionManager.ALLOW_ACTION);
    });
  }
}

function startup() {
  Services.obs.addObserver(onNewIframe, "remote-browser-shown", false);
  Services.obs.addObserver(onNewIframe, "inprocess-browser-shown", false);
}

function shutdown() {
  Services.obs.removeObserver(onNewIframe, "remote-browser-shown", false);
  Services.obs.removeObserver(onNewIframe, "inprocess-browser-shown", false);
}
