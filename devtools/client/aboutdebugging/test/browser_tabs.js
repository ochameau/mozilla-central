/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TAB_URL = "data:text/html,<title>foo</title>";

add_task(function* () {
  dump("open about:debugging\n");
  let { tab, document } = yield openAboutDebugging("tabs");
  dump("open about:debugging DONE\n");

  // Wait for initial tabs list which may be empty
  let tabsElement = getTabList(document);
  if (tabsElement.querySelectorAll(".target-name").length == 0) {
    dump("wait for initial tabs loading\n");
    yield waitForMutation(tabsElement, { childList: true });
    dump("wait for initial tabs loading DONE\n");
  }
  // Refresh tabsElement to get the .target-list element
  tabsElement = getTabList(document);

  let names = [...tabsElement.querySelectorAll(".target-name")];
  let initialTabCount = names.length;

  dump("initialNamesCount:"+names.length+"\n");
  dump("initialNames:"+names.map(a=>a.textContent)+"\n");

  // Open a new tab in background and wait for its addition in the UI
  let onNewTab = waitForMutation(tabsElement, { childList: true });
  dump("addTab\n");
  let newTab = yield addTab(TAB_URL, null, true);
  dump("addTabDone\n");
  yield onNewTab;
  dump("got the mutation\n");

  // Check that the new tab appears in the UI, but with an empty name
  let newNames = [...tabsElement.querySelectorAll(".target-name")];
  newNames = newNames.filter(node => !names.includes(node));
  is(newNames.length, 1, "A new tab appeared in the list");
  let newTabTarget = newNames[0];

  // Then wait for title update, but on slow test runner, the title may already
  // be set to the expected value
  if (newTabTarget.textContent != "foo") {
    yield waitForMutation(newTabTarget, { childList: true });
  }

  // Check that the new tab appears in the UI
  is(newTabTarget.textContent, "foo", "The tab title got updated");
  is(newTabTarget.title, TAB_URL, "The tab tooltip is the url");

  // Finally, close the tab
  let onTabsUpdate = waitForMutation(tabsElement, { childList: true });
  yield removeTab(newTab);
  yield onTabsUpdate;

  // Check that the tab disappeared from the UI
  names = [...tabsElement.querySelectorAll("#tabs .target-name")];
  is(names.length, initialTabCount, "The tab disappeared from the UI");

  yield closeAboutDebugging(tab);
});
