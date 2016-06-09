
dump('Utils\n');

// Manages tab mappings and permissions for a specific extension.
function ExtensionTabManager(extension) {
  this.extension = extension;

  // A mapping of tab objects to the inner window ID the extension currently has
  // the active tab permission for. The active permission for a given tab is
  // valid only for the inner window that was active when the permission was
  // granted. If the tab navigates, the inner window ID changes, and the
  // permission automatically becomes stale.
  //
  // WeakMap[tab => inner-window-id<int>]
  this.hasTabPermissionFor = new WeakMap();
}

ExtensionTabManager.prototype = {
  addActiveTabPermission(tab = TabManager.activeTab) {
    if (this.extension.hasPermission("activeTab")) {
      // Note that, unlike Chrome, we don't currently clear this permission with
      // the tab navigates. If the inner window is revived from BFCache before
      // we've granted this permission to a new inner window, the extension
      // maintains its permissions for it.
      this.hasTabPermissionFor.set(tab, tab.linkedBrowser.innerWindowID);
    }
  },

  // Returns true if the extension has the "activeTab" permission for this tab.
  // This is somewhat more permissive than the generic "tabs" permission, as
  // checked by |hasTabPermission|, in that it also allows programmatic script
  // injection without an explicit host permission.
  hasActiveTabPermission(tab) {
    // This check is redundant with addTabPermission, but cheap.
    if (this.extension.hasPermission("activeTab")) {
      return (this.hasTabPermissionFor.has(tab) &&
              this.hasTabPermissionFor.get(tab) === tab.linkedBrowser.innerWindowID);
    }
    return false;
  },

  hasTabPermission(tab) {
    return this.extension.hasPermission("tabs") || this.hasActiveTabPermission(tab);
  },

  convert(tab) {
    let window = tab.ownerDocument.defaultView;

    let result = {
      id: TabManager.getId(tab),
      index: tab._tPos,
      windowId: WindowManager.getId(window),
      selected: tab.selected,
      highlighted: tab.selected,
      active: tab.selected,
      pinned: tab.pinned,
      status: TabManager.getStatus(tab),
      incognito: false, //PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser),
      width: tab.clientWidth,
      height: tab.clientHeight,
    };

    if (this.hasTabPermission(tab)) {
      // Don't know how to get current location on <iframe mozbrowser>?
      result.url = tab.parentNode.wrappedJSObject.location;
      //dump("convertTab, location:"+result.url+"\n");
      /*
      if (tab.linkedBrowser.contentTitle) {
        result.title = tab.linkedBrowser.contentTitle;
      }
      let icon = window.gBrowser.getIcon(tab);
      if (icon) {
        result.favIconUrl = icon;
      }
      */
    }

    return result;
  },

  getTabs(window) {
    return Array.from(window.gBrowser.tabs, tab => this.convert(tab));
  },
};


let idCount = 1;
const uuidMap = new Map();
// TODO: Use a map of tabs to prevent iterating over frames()

// Overrides TabManager defined in browser/components/extensions/ext-utils.js
// in order to support generic HTML browser
global.TabManager = {
  _tabs: new WeakMap(),
  _nextId: 1,

  frames() {
    let frames = function (window) {
      let list = [...window.document.querySelectorAll("iframe")];
      for(let frame of list) {
        // XXX: Only consider frames with uuid attributes
        // /!\ makes assumptions on the HTML
        if (frame.getAttribute("uuid")) {
          yield frame;
        }
        if (frame.contentWindow) {
          for (let f of frames(frame.contentWindow)) {
            yield f;
          }
        }
      }
    };
    for (let window of WindowListManager.browserWindows()) {
      for (let frame of frames(window)) {
        yield frame;
      }
    }
  },

  getIdForUUID(uuid) {
    let id = uuidMap.get(uuid);
    if (!id) {
      id = idCount++;
      uuidMap.set(uuid, id);
    }
    //dump(uuid+" maps to "+id+"\n");
    return id;
  },

  getId(tab) {
    let uuid = tab.getAttribute("uuid");
    if (!uuid) {
      throw new Error("tab without uuid attribute");
    }
    return this.getIdForUUID(uuid);
  },

  getBrowserId(browser) {
    return this.getId(browser);
  },

  getTab(tabId) {
    for(let frame of this.frames()) {
      if (this.getId(frame) == tabId) {
        return frame;
      }
    }
    return null;
  },

  get activeTab() {
    for(let frame of this.frames()) {
      if (frame.getVisible()) {
        return frame;
      }
    }
    return null;
  },

  getStatus(tab) {
    // TODO
    return "complete";
  },

  convert(extension, tab) {
    return TabManager.for(extension).convert(tab);
  },
};

// WeakMap[Extension -> ExtensionTabManager]
let tabManagers = new WeakMap();

// Returns the extension-specific tab manager for the given extension, or
// creates one if it doesn't already exist.
TabManager.for = function(extension) {
  if (!tabManagers.has(extension)) {
    tabManagers.set(extension, new ExtensionTabManager(extension));
  }
  return tabManagers.get(extension);
};

/* eslint-disable mozilla/balanced-listeners */
extensions.on("shutdown", (type, extension) => {
    tabManagers.delete(extension);
});
/* eslint-enable mozilla/balanced-listeners */

dump('Utils: parsed.\n');
