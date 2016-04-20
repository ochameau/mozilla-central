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
  const { require } = Cu.import("resource://devtools/shared/Loader.jsm", {});
  const { targetFromURL } = require("devtools/client/framework/target-from-url");
  const { Task } = require("resource://gre/modules/Task.jsm");
  const Services = require("Services");

  Task.spawn(function *() {
    let target = yield targetFromURL(url);

    let { WebConsolePanel } = require("devtools/client/webconsole/panel");

    let fakeToolbox = {
      target,
      _target: target,
      hostType: "bottom",
      doc: window.document,
      on() {}, emit() {},
    };

    let panel = new WebConsolePanel(window, fakeToolbox);
    panel.open();
  }).then(null, e => {
    window.alert("Unable to start the debugger:" + e.message + "\n" + e.stack);
  });
}
