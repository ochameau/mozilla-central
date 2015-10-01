#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

import os
import sys
import re
import weakref
from marionette.marionette_test import MarionetteTestCase, MarionetteJSTestCase, JSTest, _ExpectedFailure, _UnexpectedSuccess
from marionette_driver.errors import ScriptTimeoutException

class LucidDreamJavascriptTestCase(MarionetteTestCase):
    match_re = re.compile(r"browser_(.*)\.js$")
    gecko_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    luciddream_dir = os.path.join(gecko_dir, "devtools", "client", "shared", "luciddream")

    def __init__(self, marionette_weakref, browser=None, logger=None, **kwargs):
        self.browser = browser
        self.logger = logger
        # Set `jsFile` so that MarionetteTestCase prints the JS file name
        # instead of the current python file name
        self.jsFile = kwargs["filepath"]
        MarionetteTestCase.__init__(self, marionette_weakref, **kwargs)

    @classmethod
    def add_tests_to_suite(cls, mod_name, filepath, suite, testloader, marionette, testvars, **kwargs):
        suite.addTest(LucidDreamJavascriptTestCase(weakref.ref(marionette),
                      methodName="test_luciddream",
                      filepath=filepath,
                      testvars=testvars,
                      **kwargs))

    def setup_b2g(self, marionette):
        marionette.set_context("chrome")

        head = os.path.join(self.luciddream_dir, "b2g-head.js")
        js = open(head, 'r').read()
        results = marionette.execute_js_script(js,
                                               [],
                                               new_sandbox=False,
                                               filename=head)

    def test_luciddream(self):
        # Asserts that both marionettes, to b2g and browser are alive
        self.assertIsNotNone(self.marionette.session)
        self.assertIsNotNone(self.browser.session)

        # Execute setup code on b2g runtime, but only once
        if not hasattr(self.marionette, "is_b2g_luciddram_ready"):
            self.marionette.is_b2g_luciddram_ready = True
            self.setup_b2g(self.marionette)

        # Then, execute the test on browser runtime,
        # in the same chrome sandbox
        self.browser.set_context("chrome")

        try:
            luciddream_head = os.path.join(self.luciddream_dir, "browser-head.js")
            js = open(luciddream_head, 'r').read()
            results = self.browser.execute_js_script(js,
                                                     [],
                                                     filename=luciddream_head)

            # Set by /testing/mochitest/browser-test.js
            self.browser.execute_script("this.gTestPath = arguments[0];", ["file://" + self.filepath], new_sandbox=False)

            #self.browser.execute_script("this.LUCIDDREAM = {};", new_sandbox=False)

            # Run the test head.js
            head = os.path.join(os.path.dirname(self.filepath), "head.js")
            js = open(head, 'r').read() + "\nfinish()"
            results = self.browser.execute_js_script(js,
                                                     [],
                                                     new_sandbox=False,
                                                     #async=False,
                                                     filename=head)

            # Now, we can run the test file itself
            js = open(self.filepath, 'r').read()
            results = self.browser.execute_js_script(js,
                                                     [],
                                                     new_sandbox=False,
                                                     script_timeout=120000,
                                                     filename=self.filepath)
            self.process_results(results)

        except ScriptTimeoutException, e:
            self.browser.execute_js_script("LUCIDDREAM.cleanup()", new_sandbox=False)
            raise e

        self.browser.execute_js_script("LUCIDDREAM.cleanup()", new_sandbox=False)

    def process_results(self, results):
        for failure in results['failures']:
            diag = "" if failure.get('diag') is None else failure['diag']
            name = "got false, expected true" if failure.get('name') is None else failure['name']
            self.logger.test_status(self.test_name, name, 'FAIL',
                                    message=diag)
        for failure in results['expectedFailures']:
            diag = "" if failure.get('diag') is None else failure['diag']
            name = "got false, expected false" if failure.get('name') is None else failure['name']
            self.logger.test_status(self.test_name, name, 'FAIL',
                                    expected='FAIL', message=diag)
        for failure in results['unexpectedSuccesses']:
            diag = "" if failure.get('diag') is None else failure['diag']
            name = "got true, expected false" if failure.get('name') is None else failure['name']
            self.logger.test_status(self.test_name, name, 'PASS',
                                    expected='FAIL', message=diag)
        self.assertEqual(0, len(results['failures']),
                         '%d tests failed' % len(results['failures']))
        if len(results['unexpectedSuccesses']) > 0:
            raise _UnexpectedSuccess('')
        if len(results['expectedFailures']) > 0:
            raise _ExpectedFailure((AssertionError, AssertionError(''), None))

        self.assertTrue(results['passed']
                        + len(results['failures'])
                        + len(results['expectedFailures'])
                        + len(results['unexpectedSuccesses']) > 0,
                        'no tests run')


class LucidDreamPythonTestCase(MarionetteTestCase):
    def __init__(self, marionette_weakref, browser=None, logger=None, **kwargs):
        self.browser = browser
        self.logger = logger
        MarionetteTestCase.__init__(self, marionette_weakref, **kwargs)

    def run_js_test(self, filename, marionette):
        '''
        Run a JavaScript test file and collect its set of assertions
        into the current test's results.

        :param filename: The path to the JavaScript test file to execute.
                         May be relative to the current script.
        :param marionette: The Marionette object in which to execute the test.
        '''
        caller_file = sys._getframe(1).f_globals.get('__file__', '')
        caller_file = os.path.abspath(caller_file)
        script = os.path.join(os.path.dirname(caller_file), filename)
        self.assert_(os.path.exists(script), 'Script "%s" must exist' % script)
        return MarionetteTestCase.run_js_test(self, script, marionette)
