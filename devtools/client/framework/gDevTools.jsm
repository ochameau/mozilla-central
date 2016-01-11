/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = [ "gDevTools", "DevTools", "gDevToolsBrowser" ];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Make most dependencies be reloadable so that the reload addon
// can update all of them while keeping gDevTools.jsm as-is
// Bug 1188405 is going to refactor this JSM into a commonjs module
// so that it can be reloaded as other modules.
let require, loader, promise, DefaultTools, DefaultThemes;
let loadDependencies = () => {
  let l = Cu.import("resource://devtools/shared/Loader.jsm", {});
  require = l.require;
  loader = l.loader;
};
loadDependencies();

// Load the browser devtools main module as the loader's main module.
loader.main("devtools/client/main");
