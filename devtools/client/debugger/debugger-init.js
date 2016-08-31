/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// URL constructor doesn't support chrome: scheme
let href = window.location.href.replace(/chrome:/, "http://");
let url = new window.URL(href);

// Only use this method to attach the toolbox if some query parameters are given
if (url.search.length > 1) {
  const Cu = Components.utils;
  const Ci = Components.interfaces;
  const { targetFromURL } = require("devtools/client/framework/target-from-url");
  const { attachThread, detachThread } = require("devtools/client/framework/attach-thread");
  const { Task } = require("resource://gre/modules/Task.jsm");

  // `host` is the frame element loading the tool.
  let host = window.QueryInterface(Ci.nsIInterfaceRequestor)
                   .getInterface(Ci.nsIDOMWindowUtils)
                   .containerElement;

  Task.spawn(function *() {
    let target = yield targetFromURL(url);

    // attachThread also expect a toolbox as argument
    let threadClient = yield attachThread({ target });

    let { DebuggerPanel } = require("devtools/client/debugger/panel");

    let fakeToolbox = {
      target,
      threadClient,
      hostType: "bottom",
      unhighlightTool() {},
    };

    let panel = new DebuggerPanel(window, fakeToolbox);
    panel.open();
  }).then(null, e => {
    window.alert("Unable to start the debugger:" + e.message + "\n" + e.stack);
  });
}
