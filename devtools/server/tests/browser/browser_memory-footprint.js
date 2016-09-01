/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Probe memory usage of devtools debugger server
 */

const { DevToolsLoader } = Cu.import("resource://devtools/shared/Loader.jsm", {});

let gMgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);

SimpleTest.requestCompleteLog();  // so that "PERFHERDER_DATA" can be scraped from the log

// Attempt to do the most complete garbage collection
function* gc() {
  Services.obs.notifyObservers(null, "memory-pressure", "heap-minimize");
  Cu.forceGC();
  Cu.forceCC();
  yield new Promise(done => {
    Cu.schedulePreciseShrinkingGC(done);
  });
  info("gc-ed");
}

// Process all concurrent events
function processPendingEvents() {
  let start = new Date().getTime();
  while(Services.tm.currentThread.hasPendingEvents()) {
    Services.tm.currentThread.processNextEvent(true);
  }
  let duration = new Date().getTime() - start;
  info("Processed events during " + duration + "ms");
  return duration;
}

add_task(function* () {
  // Force freeing memory until firefox is done doing things.
  // processPendingEvents should return immediately once there is no other
  // event being processed.
  while(processPendingEvents() > 50) {
    yield gc();
  }

  let refMemory = gMgr.residentUnique;
  let subtests = [];

  let loader = new DevToolsLoader();
  let { DebuggerServer } = loader.require("devtools/server/main");
  check_footprint("DevToolsServer module");

  DebuggerServer.init();
  DebuggerServer.addBrowserActors();
  check_footprint("DebuggerServer.addBrowserActors()");

  let client = new DebuggerClient(DebuggerServer.connectPipe());
  yield client.connect();
  check_footprint("DebuggerClient.connect()");

  yield client.listTabs();
  check_footprint("DebuggerClient.listTabs()");

  logToPerfHerder();
  ok(true, "Sent data to perfherder");
  yield client.close();

  function check_footprint(name) {
    let footprint = (gMgr.residentUnique - refMemory) / 1024;
    subtests.push({ name, value: footprint });
  }

  function logToPerfHerder() {
    let footprint = (gMgr.residentUnique - refMemory) / 1024;
    let PERFHERDER_DATA = {
      framework: { name: "awsy" },
      suites: [{
        subtests,
        name: "Devtools memory usage", value: footprint
      }]
    };
    info("PERFHERDER_DATA: " + JSON.stringify(PERFHERDER_DATA));
  }
});
