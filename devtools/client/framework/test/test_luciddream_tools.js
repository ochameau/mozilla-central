MARIONETTE_CONTEXT = "chrome";
MARIONETTE_TIMEOUT = 180000;

Cu.import("resource://gre/modules/Task.jsm");
const {require} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const promise = require("promise");
let loader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);
let EventUtils = {};
loader.loadSubScript("chrome://marionette/content/EventUtils.js", EventUtils);

Services.prefs.setBoolPref("devtools.webide.autoinstallADBHelper", false);
Services.prefs.setBoolPref("devtools.webide.autoinstallFxdtAdapters", false);

function openWebIDE() {
  let deferred = promise.defer();

  let win = Services.ww.openWindow(null, "chrome://webide/content/", "webide", "chrome,centerscreen,resizable", null);
  win.onload = function () {
    // Wait a tick, in order to let AppManager be available on `win`
    setTimeout(function () {
      deferred.resolve(win);
    });
  };

  return deferred.promise;
}

function connect(win) {
  // Create and register a fake runtime that will allow us to connect to an
  // arbitrary port
  const { _SimulatorRuntime } = win.require("devtools/webide/runtimes");
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
      win.AppManager.selectedProject.type === "mainProcess") {
    return promise.resolve();
  }

  let deferred = promise.defer();

  let btn = win.document.querySelector("menuitem[command='cmd_showProjectPanel']");
  btn.click();
  setTimeout(function () {
    let appNode = win.document.querySelector("#project-panel-runtimeapps > .panel-item[label=\"Main Process\"]");
    appNode.click();

    setTimeout(function () {
      deferred.resolve();
    });
  });

  return deferred.promise;
}

function openTool(toolbox, tool) {
  return toolbox.selectTool(tool);
}

function checkConsole(panel) {
  let deferred = promise.defer();

  //XXX: figure out why panel.panelWin doesn't exists
  // >> looks like WebConsolePanel just doesn't set it,
  //    even if it looks like some tests rely on it !!???
  let window = panel.hud.iframeWindow;
  let hud = panel.hud;

  hud.ui.on("new-messages", function (event, messages) {
    for (let msg of messages) {
      let elem = msg.node;
      let body = elem.querySelector(".message-body");
      if (body.textContent.contains("shell.html")) {
        ok(true, "Console works and we are evaluating within the main process");
        deferred.resolve();
      }
    }
  });

  // Simulate input in the console
  hud.jsterm.inputNode.focus();
  hud.jsterm.setInputValue("window.location.href");
  EventUtils.synthesizeKey("VK_RETURN", {}, window);

  return deferred.promise;
}

function checkInspector(inspector) {
  // Select the system app iframe
  let walker = inspector.walker;
  let updated = inspector.once("inspector-updated");
  walker.querySelector(walker.rootNode, "#systemapp")
        .then(nodeFront => {
          inspector.selection.setNodeFront(nodeFront, "test");
        });
  return updated.then(() => {
    is(inspector.selection.nodeFront.id, "systemapp", "Inspector works and is targetting the main process");
  });
}

Task.spawn(function () {
  let win = yield openWebIDE();
  yield connect(win);
  yield selectApp(win);
  let toolbox = yield win.UI.toolboxPromise;
  let console = yield openTool(toolbox, "webconsole");
  yield checkConsole(console);
  let inspector = yield openTool(toolbox, "inspector");
  yield checkInspector(inspector);
  finish();
}).catch(e => {
  ok(false, "Exception: " + e + "\n" + e.stack);
  // XXX: We have to call finish in order to be able to see assertions!
  finish()
});
