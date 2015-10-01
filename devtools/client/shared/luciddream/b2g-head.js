// Enable devtools server
Services.prefs.setCharPref("devtools.debugger.unix-domain-socket", "6666");
Services.prefs.setBoolPref("devtools.debugger.prompt-connection", false)
navigator.mozSettings.createLock().set({"debugger.remote-mode": "adb-devtools"})

// Enable system app debugging
Services.prefs.setBoolPref("devtools.debugger.forbid-certified-apps", false)

// Disable the lockscreen to allow connections
navigator.mozSettings.createLock().set({"lockscreen.enabled": false})

// Disable screen timeout as it overlaps apps with a DOM Element and makes some tests to fails
// (and also prevent seeing what happens with your test document!!)
navigator.mozSettings.createLock().set({"screen.timeout": 0})

// Wait for devtools to be setup and listening
const {require} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {DebuggerServer} = require("devtools/server/main");
function check() {
  if (DebuggerServer.initialized) {
    finish();
  } else {
    setTimeout(check, 250);
  }
}
check();
