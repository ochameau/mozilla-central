# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

from luciddream import LucidDreamTestCase

class TestSample(LucidDreamTestCase):
    def setup_b2g(self):
        self.marionette.set_context("chrome")

        # Enable devtools and setup test port
        self.marionette.execute_script("Services.prefs.setCharPref('devtools.debugger.unix-domain-socket', '6666')")
        self.marionette.execute_script("Services.prefs.setBoolPref('devtools.debugger.prompt-connection', false)")
        self.marionette.execute_script("navigator.mozSettings.createLock().set({'debugger.remote-mode': 'adb-devtools'})")

        # Enable system app debugging
        self.marionette.execute_script("Services.prefs.setBoolPref('devtools.debugger.forbid-certified-apps', false)")

        # Disable the lockscreen to allow connections
        self.marionette.execute_script("navigator.mozSettings.createLock().set({'lockscreen.enabled': false})")

        # Wait for devtools to be setup and listening
        v = self.marionette.execute_async_script("""
          const { require } = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
          const { DebuggerServer } = require("devtools/server/main");
          function check() {
            if (true || DebuggerServer.initialized) {
              marionetteScriptFinished('ok');
            } else {
              setTimeout(check, 250);
            }
          }
          check();
        """)
        
    def test_sample(self):
        self.assertIsNotNone(self.marionette.session)
        self.assertIsNotNone(self.browser.session)
        self.setup_b2g()

        self.browser.set_context("chrome")
        self.run_js_test("test_luciddream_tools.js", self.browser)
