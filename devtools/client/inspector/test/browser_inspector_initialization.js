/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const TEST_URI = "data:text/html;charset=utf-8,<body style='color:red'>foo</body>";

requestLongerTimeout(3);

function* unloadDevtools() {
  Services.ppmm.loadProcessScript("data:,new " + function () {
    /* Flush message manager cached frame scripts as well as chrome locales */
    let obs = Components.classes["@mozilla.org/observer-service;1"]
                        .getService(Components.interfaces.nsIObserverService);
    obs.notifyObservers(null, "message-manager-flush-caches", null);

    /* Also purge cached modules in child processes, we do it a few lines after
       in the parent process */
    if (Services.appinfo.processType == Services.appinfo.PROCESS_TYPE_CONTENT) {
      Services.obs.notifyObservers(null, "devtools-unload", "reload");
    }
  }, false);
  Services.obs.notifyObservers(null, "devtools-unload", "reload");
  Cu.unload("resource://devtools/shared/Loader.jsm");
}

add_task(function* () {
  let timings = [];

  yield new Promise(done => window.setTimeout(done, 2000));

  let gDT = gDevTools;
  let TF = TargetFactory;
  for (let i = 0; i < 10; i++) {
    let tab = yield addTab(TEST_URI);
    let target = TF.forTab(tab);
    let start = new Date().getTime();
    let toolbox = yield gDT.showToolbox(target, "inspector");
    let inspector = toolbox.getCurrentPanel();
    yield selectNode("body", inspector);
    timings.push(new Date().getTime()-start);
    if (target) {
      yield gDT.closeToolbox(target);
    }
    yield removeTab(tab);

    yield unloadDevtools();

    let {devtools} = Cu.import("resource://devtools/shared/Loader.jsm", {});
    devtools.require("devtools/client/framework/devtools-browser");
    gDT = devtools.require("devtools/client/framework/devtools").gDevTools;
    TF = devtools.require("devtools/client/framework/target").TargetFactory;
  }

  dump("Timings > "+timings.join(", ")+"\n");
  timings.sort();
  let min = 100000, avg = 0, max = 0;
  timings.forEach(t => {
    min = Math.min(min, t);
    avg += t;
    max = Math.max(max, t);
  });
  avg /= timings.length;
  dump("Min : "+min+"\n");
  dump("Average : "+avg+"\n");
  dump("Middle : "+timings[Math.floor(timings.length/2)-1]+"\n");
  dump("Max : "+max+"\n");
  ok(true, "ok");
});
