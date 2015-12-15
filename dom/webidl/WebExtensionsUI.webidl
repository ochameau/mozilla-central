/* -*- Mode: IDL; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 */

[JSImplementation="@mozilla.org/webextensions/extension;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue"]
interface WebExtension {
  readonly attribute DOMString name;
  DOMString localize(DOMString msg);
  readonly attribute URL baseURL;
};

[JSImplementation="@mozilla.org/webextensions/bookmarks;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue"]
interface WebExtensionBookmarks {
  void create(any bookmarkObject, any callback);
  void getTree(any callback);
};

[JSImplementation="@mozilla.org/webextensions/extensions;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue",
 NavigatorProperty="webExtensions"]
interface WebExtensions {
  readonly attribute WebExtensionBookmarks bookmarks;
};

callback WebExtensionListener = void (object event);

[JSImplementation="@mozilla.org/webextensions/eventListener;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue",
 Constructor(any contextA, DOMString nameA, WebExtensionListener registerA)]
interface WebExtensionEventListener {
  void addListener(WebExtensionListener listener);
  void removeListener(WebExtensionListener listener);
};

[JSImplementation="@mozilla.org/webextensions/browserAction;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue",
 Constructor(WebExtension extension, any context)]
interface WebExtensionBrowserAction {
  readonly attribute WebExtensionEventListener onClicked;
  void enable(optional DOMString tabId);
  void disable(optional DOMString tabId);
};

[JSImplementation="@mozilla.org/webextensions/tabs;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue",
 Constructor(WebExtension extension, any context)]
interface WebExtensionTabs {
  void create(any options, any callback);
};

callback ExtCallback = void (DOMString type, DOMString directive, WebExtension extension, any manifest);
callback ExtCallback2 = object (WebExtension extension, any manifest);

[JSImplementation="@mozilla.org/webextensions/ui-glue;1",
 Pref="dom.webextensions-uiglue.enabled",
 CheckAnyPermissions="webextensions-uiglue",
 NavigatorProperty="webExtensionsUIGlue"]
interface WebExtensionsUIGlue {
  void registerAPI(ExtCallback2 api);
  void registerWebIDLImplementation(DOMString interface, any impl);

  void on(DOMString type, ExtCallback callback);
  void off(DOMString type, ExtCallback callback);

  any instanciateAddon(DOMString id, object manifest);
};
