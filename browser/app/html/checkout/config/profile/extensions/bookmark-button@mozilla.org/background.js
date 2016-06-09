"use strict";
function isBookmarked(tab) {
  let url = tab.url;
  return new Promise(done => {
    chrome.bookmarks.getTree(function (results) {
      let bookmark = undefined;
      let search = function (node) {
        if (node.url === url)
          bookmark = node;
        if (node.children)
          node.children.forEach(search);
      };
      results.forEach(search);

      done(bookmark);
    });
  });
}
function updateTab(tab) {
  let url = tab.url;
  isBookmarked(tab).then(bookmark => {
    if (!bookmark) {
      chrome.browserAction.setIcon({ path: "unstarred.png" });
      //chrome.browserAction.setPopup({ popup: null });
    } else {
      chrome.browserAction.setIcon({ path: "starred.png" });
      //chrome.browserAction.setPopup({ popup: "bookmark.html" });
    }
  });
}
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  updateTab(tab);
});

chrome.tabs.onActivated.addListener(function ({tabId, windowId}) {
  chrome.tabs.get(tabId, function (tab) {
    updateTab(tab);
  });
});
chrome.browserAction.onClicked.addListener(function (tab) {
  isBookmarked(tab).then(bookmark => {
    if (bookmark) {
      chrome.bookmarks.remove(bookmark.id, function () {
        updateTab(tab);
      });
    } else {
      chrome.bookmarks.create({url: tab.url, title: tab.title}, function () {
        updateTab(tab);
      });
    }
  });
});
