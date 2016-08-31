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
  const { attachThread, detachThread } = require("devtools/client/framework/attach-thread");
  const { Task } = require("resource://gre/modules/Task.jsm");
  const Services = require("Services");
  const { BrowserLoader } =
    Cu.import("resource://devtools/client/shared/browser-loader.js", {});

  Task.spawn(function *() {
    let target = yield targetFromURL(url);

    // attachThread also expect a toolbox as argument
    //let threadClient = yield attachThread({ target });

    let { InspectorPanel } = require("devtools/client/inspector/inspector-panel");

    let { Selection } = require("devtools/client/framework/selection");
    let { InspectorFront } = require("devtools/shared/fronts/inspector");
    let { getHighlighterUtils } = require("devtools/client/framework/toolbox-highlighter-utils");

    dump("go create fronts\n");
    let inspector = InspectorFront(target.client, target.form);
    let walker = yield inspector.getWalker(
      {showAllAnonymousContent: Services.prefs.getBoolPref("devtools.inspector.showAllAnonymousContent")}
    );
    let selection = new Selection(walker);
    let highlighter = yield inspector.getHighlighter(false);
    dump("fronts created\n");

    let fakeToolbox = {
      target,
      _target: target,
      hostType: "bottom",
      inspector, walker, selection, highlighter,
      doc: window.document,
      win: window,
      on() {}, emit() {}, off() {},
      initInspector() {},
      browserRequire: BrowserLoader({
        window: window,
        useOnlyShared: true
      }).require,
      get React() {
        return this.browserRequire("devtools/client/shared/vendor/react");
      },
      get ReactDOM() {
        return this.browserRequire("devtools/client/shared/vendor/react-dom");
      },
      isToolRegistered() {
        return false;
      },
    };
    fakeToolbox.highlighterUtils = getHighlighterUtils(fakeToolbox);

    let panel = new InspectorPanel(window, fakeToolbox);
    panel.open();
  }).then(null, e => {
    window.alert("Unable to start the inspector:" + e.message + "\n" + e.stack);
  });
}
