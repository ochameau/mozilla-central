
(function onBrowserStartup(global) {
  'use strict';

  navigator.serviceWorker.register('sw.js').then(function(registration) {
    dump('ServiceWorker registration success for: ' + registration.scope + '\n');
  }).catch(function(error) {
    dump('ServiceWorker registration failed: ' + error + '\n');
  });

  const HOMEPAGE = 'about:home';

  Services.ready.then(() => {
    // Process query parameters set by /browser/components/nsBrowserContentHandler.js
    // Like urls to open specified by the command line,
    // or the startup page.
    let search = new URL(location).searchParams;
    let urls = search.getAll("url");
    if (urls.length == 0) {
      Services.tabs.method('add', {
        url: HOMEPAGE,
        loading: true,
        select: true
      });

    } else {
      let postData = search.getAll("postData");
      urls.forEach((url, i) => {
        // TODO: use postData[i] for search requests
        Services.tabs.method("add", {
          url: url,
          select: i == urls.length - 1
        });
      });
    }
  });

  window.addEventListener("message", e => {
    if (e.data && e.data.location) {
      Services.tabs.method("add", {
        url: e.data.location,
        select: true
      });
    }
  });
})(self);
