/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {Cc, Ci, Cu, Cr} = require("chrome");

let promise = require("promise");

this.ToolboxPanel = function ToolboxPanel(panelWin, toolbox) {
  EventEmitter.decorate(this);

  this._toolbox = toolbox;
  this._target = toolbox.target;
  this._panelWin = panelWin;
  this._panelDoc = panelWin.document;

  this._panelWin.wrappedJSObject.load(toolbox, toolbox.target);
}

exports.ToolboxPanel = ToolboxPanel;

ToolboxPanel.prototype = {
  get target() this._toolbox.target,

  get panelWindow() this._panelWin,

  hidePopup: function () {},

  open: function() {
    return promise.resolve(this);
  },

  destroy: function() {
    if (!this._destroyed) {
      this._destroyed = true;

      this._target.off("close", this.destroy);
      this._target = null;
      this._toolbox = null;
      this._panelDoc = null;
    }

    return promise.resolve(null);
  },
}
