/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Service workers can't be loaded from chrome://,
// but http:// is ok with dom.serviceWorkers.testing.enabled turned on.
const SERVICE_WORKER = URL_ROOT + "service-workers/empty-sw.js";
const TAB_URL = URL_ROOT + "service-workers/empty-sw.html";

add_task(function* () {
  yield new Promise(done => {
    let options = {"set": [
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
    ]};
    SpecialPowers.pushPrefEnv(options, done);
  });

  let { tab, document } = yield openAboutDebugging("workers");

  let swTab = yield addTab(TAB_URL);

  let serviceWorkersElement = getServiceWorkerList(document);

  yield waitForMutation(serviceWorkersElement, { childList: true });

  // Ensure that the registration resolved
  let frameScript = function () {
    // Retrieve the `sw` promise created in the html page
    let { sw } = content.wrappedJSObject;
    sw.then(function (registration) {
      sendAsyncMessage("sw-registered");
    });
  };
  let mm = swTab.linkedBrowser.messageManager;
  mm.loadFrameScript("data:,(" + encodeURIComponent(frameScript) + ")()", true);

  yield new Promise(done => {
    mm.addMessageListener("sw-registered", function listener() {
      mm.removeMessageListener("sw-registered", listener);
      done();
    });
  });
  ok(true, "Service worker registration resolved");

  // Check that the service worker appears in the UI
  let names = [...document.querySelectorAll("#service-workers .target-name")];
  names = names.map(element => element.textContent);
  ok(names.includes(SERVICE_WORKER),
    "The service worker url appears in the list: " + names);

  // Finally, unregister the service worker itself
  let aboutDebuggingUpdate = waitForMutation(serviceWorkersElement,
    { childList: true });

  try {
    yield unregisterServiceWorker(swTab);
    ok(true, "Service worker registration unregistered");
  } catch (e) {
    ok(false, "SW not unregistered; " + e);
  }

  yield aboutDebuggingUpdate;

  // Check that the service worker disappeared from the UI
  names = [...document.querySelectorAll("#service-workers .target-name")];
  names = names.map(element => element.textContent);
  ok(!names.includes(SERVICE_WORKER),
    "The service worker url is no longer in the list: " + names);

  yield removeTab(swTab);
  yield closeAboutDebugging(tab);
});
