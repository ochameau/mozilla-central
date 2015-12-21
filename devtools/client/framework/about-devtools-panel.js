/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Register about:devtools-panel which allows to open a devtools toolbox
// in a Firefox tab or a custom html iframe in browser.html

const { Ci, Cu, components } = require("chrome");
const Cm = components.manager.QueryInterface(Ci.nsIComponentRegistrar);
const { XPCOMUtils } = Cu.import("resource://gre/modules/XPCOMUtils.jsm", {});
const { Services } = Cu.import("resource://gre/modules/Services.jsm", {});

function AboutURL() {
}

AboutURL.prototype = {
  uri: Services.io.newURI("chrome://devtools/content/framework/toolbox.xul", null, null),
  classDescription: "about:devtools-panel",
  classID: components.ID("11342911-3135-45a8-8d71-737a2b0ad469"),
  contractID: "@mozilla.org/network/protocol/about;1?what=devtools-panel",

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAboutModule]),

  newChannel : function(aURI, aLoadInfo) {
    let chan = Services.io.newChannelFromURIWithLoadInfo(this.uri, aLoadInfo);
    chan.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return chan;
  },

  getURIFlags: function(aURI) {
    return 0;
  }
};

let cls = AboutURL;
const factory = {
  _cls: cls,
  createInstance: function(outer, iid) {
    if (outer) {
      throw Cr.NS_ERROR_NO_AGGREGATION;
    }
    return new cls();
  }
};

exports.register = function () {
  Cm.registerFactory(cls.prototype.classID, cls.prototype.classDescription, cls.prototype.contractID, factory);
}
exports.unregister = function () {
  Cm.unregisterFactory(cls.prototype.classID, factory);
}
