/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

(function (scope) {

const {Task} = Cu.import("resource://gre/modules/Task.jsm", {});
const {require} = Cu.import("resource://gre/modules/devtools/shared/Loader.jsm", {});
const promise = require("promise");
const {console} = Cu.import("resource://gre/modules/devtools/shared/Console.jsm", {});

const LUCIDDREAM = scope.LUCIDDREAM = {};

const TestActorRegistry = {LUCIDDREAM: LUCIDDREAM};
const REGISTRY_URL = Components.stack.filename.replace(/^.*-> /, "").replace("browser-head.js", "../test/test-actor-registry.js");
Services.scriptloader.loadSubScript("file:///" + REGISTRY_URL, TestActorRegistry);

Services.prefs.setBoolPref("browser.dom.window.dump.enabled", true);

Services.prefs.setBoolPref("devtools.webide.autoinstallADBHelper", false);
Services.prefs.setBoolPref("devtools.webide.autoinstallFxdtAdapters", false);

function openWebIDE() {
  let win = Services.ww.getWindowByName("webide", null);
  if (win) {
    ok(true, "WebIDE already opened");
    return promise.resolve(win);
  }

  ok(true, "Opening WebIDE");
  let deferred = promise.defer();
  win = Services.ww.openWindow(null, "chrome://webide/content/", "webide", "chrome,centerscreen,resizable", null);
  win.onload = function () {
    // Wait a tick, in order to let AppManager be available on `win`
    setTimeout(function () {
      ok(true, "WebIDE opened");
      deferred.resolve(win);
    });
  };

  return deferred.promise;
}

function connect(win) {
  if (win.AppManager.selectedRuntime &&
      win.AppManager.selectedRuntime.name == "fakeRuntime") {
    ok(true, "Already connected to the runtime");
    return promise.resolve();
  }
  ok(true, "Connecting to runtime");
  // Create and register a fake runtime that will allow us to connect to an
  // arbitrary port
  const { _SimulatorRuntime } = win.require("devtools/client/webide/modules/runtimes");
  let sim = new _SimulatorRuntime("fakeSimulator");
  sim.connect = function(connection) {
    connection.host = "localhost";
    connection.port = 6666;
    // Keep connecting as b2g desktop may still be initializing when we start trying to connect
    connection.keepConnecting = true;
    connection.connect();
    return promise.resolve();
  };
  Object.defineProperty(sim, "name", {
    get() {
      return "fakeRuntime";
    }
  });
  win.AppManager.runtimeList.simulator.push(sim);
  win.AppManager.update("runtime-list");

  let deferred = promise.defer();
  // XXX: Tweak app-manager.js to make it easier to know once it is ready!
  // Wait for full connection completion, once app-manager.js
  // fully setup its internal to the new runtime
  // (i.e. runtime apps can be listed)
  win.AppManager.on("app-manager-update", (_, name) => {
    if (name == "runtime-global-actors") {
      ok(true, "Connected to runtime");
      deferred.resolve();
    }
  });

  let panelNode = win.document.querySelector("#runtime-panel");
  let items = panelNode.querySelectorAll(".runtime-panel-item-simulator");
  items[0].click();

  return deferred.promise;
}

function selectApp(win) {
  if (win.AppManager.selectedProject &&
      win.AppManager.selectedProject.name == "Clock") {
    return promise.resolve();
  }

  let deferred = promise.defer();

  let btn = win.document.querySelector("menuitem[command='cmd_showProjectPanel']");
  btn.click();
  setTimeout(function () {
    let appNode = win.document.querySelector("#project-panel-runtimeapps > .panel-item[label=\"Clock\"]");
    appNode.click();

    // Wait for the app to be launched
    win.AppManager.on("app-manager-update", function onUpdate(event, what) {
      if (what == "project-started") {
        win.AppManager.off("app-manager-update", onUpdate);
        setTimeout(function () {
          deferred.resolve();
        });
      }
    });
  });

  return deferred.promise;
}

function openTool(toolbox, tool) {
  return toolbox.selectTool(tool);
}

function openInspector(win, url) {
  return Task.spawn(function* () {
    // Get a toolbox up and running
    let toolbox;
    if (!win.UI.toolboxPromise) {
      toolbox = yield win.UI.createToolbox();
    } else {
      toolbox = yield win.UI.toolboxPromise;
    }

    // Get an inspector up and running
    let inspector;
    if (toolbox.currentToolId == "inspector") {
      inspector = toolbox.getCurrentPanel();
    } else {
      inspector = yield openTool(toolbox, "inspector");
      yield inspector.once("inspector-updated");
    }

    // Navigate to a new document
    if (url) {
      dump("navigate to: " + url + "\n");
      let activeTab = toolbox.target.activeTab;
      let onNavigated = toolbox.target.once("navigate");
      yield activeTab.navigateTo(url);

      // Wait for new-root first, before waiting for inspector-updated,
      // as we get noisy inspector-updated event*s* before new-root event,
      // that are fired early, while the inspector is still updating
      // to the new doc.
      dump("Waiting for 'new-root'\n");
      yield inspector.once("new-root");
      dump("Waiting for 'inspector-updated'\n");
      yield inspector.once("inspector-updated");

      // But in parralel, also wait for the document to be navigated
      // and that the TabActor is now targetting the new document
      dump("Waiting for 'navigate'\n");
      yield onNavigated;
    }

    let testActor = yield TestActorRegistry.getTestActor(toolbox);
    LUCIDDREAM.testActor = testActor;

    inspector.on("inspector-updated", ()=>dump("# inspector-updated\n"));
    toolbox.on("node-highlight", ()=>dump("# node-highlight\n"));
    toolbox.on("highlighter-ready", ()=>dump("# highlighter-ready\n"));
    toolbox.on("picker-node-hovered", ()=>dump("# picker-node-hovered\n"));
    toolbox.on("picker-stopped", ()=>dump("# picker-stopped\n"));
    return { inspector, toolbox, testActor };
  });
};

function getUpdatedForm(win) {
  let app = win.AppManager._getProjectFront(win.AppManager.selectedProject);
  return app.getForm(true);
};

var getTestActorWithoutToolbox = Task.async(function* (win, getTestActor) {
  if (LUCIDDREAM.testActor) {
    yield LUCIDDREAM.testActor.destroy();
  }
  let testActor = yield getTestActor(win.AppManager.connection.client);
  return LUCIDDREAM.testActor = testActor;
});

function *cleanup() {
  ok(true, "Luciddream cleanup, destroying toolbox and actor");

  // Ensure detroying the toolbox at the end of this test.
  let win = LUCIDDREAM.webideWindow;
  if (win) {
    ok(true, "Closing toolbox");
    yield win.UI.destroyToolbox();
  }
  let testActor = LUCIDDREAM.testActor;
  if (testActor) {
    ok(true, "Removing test actor");
    testActor.destroy();
  }
  finish();
}
LUCIDDREAM.cleanup = Task.async(cleanup);

// Setup the test scope similar to a mochitest scope
let tasks = 0;
function fakeMochitestScope() {
  scope.EventUtils = {};
  Services.scriptloader.loadSubScript("chrome://marionette/content/EventUtils.js", scope.EventUtils);

  // Fake mochitest scope
  scope.registerCleanupFunction = () => {},
  scope.thisTestLeaksUncaughtRejectionsAndShouldBeFixed = () => {},

  scope.executeSoon = f => {setTimeout(f, 0)},

  // Implements test harness methods that aren't implemented in marionette,
  // but exists in mochitests scope
  scope.info = msg => {
    console.log("info", msg);
  }

  // Implements add_task, that is used for asynchronous tests using Tasks
  scope.add_task = func => {
    tasks++;
    Task.spawn(func)
        .then(() => {
          ok(true, "Test passed: " + gTestPath)
        }, e => {
          ok(false, "Test throws: " + gTestPath + ": " + String(e) + "\n" + e.stack);
        })
        .then(() => {
          if (--tasks == 0) {
            dump("Finished!!\n");
            finish();
          }
        });
  }
}

// Fake a Mochitest scope
fakeMochitestScope();
Task.spawn(function () {
  // Open WebIDE
  let win = yield openWebIDE();
  LUCIDDREAM.webideWindow = win;

  // Connect to a fake local runtime matching the b2g instance
  // run by luciddream
  yield connect(win);

  // Open an app in WebIDE
  yield selectApp(win);

  LUCIDDREAM.openInspector = openInspector.bind(null, win);
  LUCIDDREAM.getUpdatedForm = getUpdatedForm.bind(null, win);
  LUCIDDREAM.getTestActorWithoutToolbox = getTestActorWithoutToolbox.bind(null, win);

  // Register the test actor ASAP, as soon as we have access
  // to registerTestActor, so that the actor is registered early
  // and gets correctly created when opening a new app/document.
  let form = yield getUpdatedForm(win);
  if (!("testActor" in form)) {
    TestActorRegistry.registerTestActor(win.AppManager.connection.client);
  }
  win.AppManager.connection.client.addListener("closed", function () {
    console.log("  !!!! CLOSED");
  });
})
.catch(e => {
  ok(false, "Exception while running head.js: " + e);
})
// Call marionette finish to terminate head.js execution
.then(finish);

})(this);
