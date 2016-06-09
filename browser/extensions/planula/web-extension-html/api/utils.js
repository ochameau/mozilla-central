
dump('Utils\n');

global.TabsState = {
  listeners: new Set(),
  addListener(listener) {
    TabsState.listeners.add(listener);
  },
  removeListener(listener) {
    TabsState.listeners.delete(listener);
  },

  nextId: 1,

  fields: [
    "index",
    "windowId",
    "selected",
    "highlighted",
    "active",
    "pinned",
    "status",
    "incognito",
    "width",
    "height",
    "audible",
    "mutedInfo",
    "url",
    "title",
    "status",
    "favIconUrl",
  ],

  tabs: new Map(),

  onEvent(event, data) {
    dump("TabsState.onEvent("+event+" - "+Object.keys(data)+")\n");
    let id = Number(data.id ? data.id : TabsState.nextId++);
    if (event == "remove") {
      this.tabs.delete(id);
    } else {
      let tab = this.tabs.get(id);

      if (!tab) {
        tab = { id };
        this.tabs.set(id, tab);
      }

      for(let name of this.fields) {
        if (!(name in data)) {
          continue;
        }
        tab[name] = data[name];
      }
    }

    dump("call "+TabsState.listeners.size+" listeners about "+id+"\n");
    TabsState.listeners.forEach(f => {
      try {
        f(event, id);
      } catch(e) {
        dump(" >> exception while calling TabsState listener: " + e + "\n" + e.stack + "\n");
      }
    });

    return id;
  },

  getTab(frame) {
    let id = TabManager.getId(frame);
    let tab = this.tabs.get(id);
    if (!tab) {
      throw new Error("Missing state for tab id=" + id);
    }
    return tab;
  },
  getTabById(id) {
    let tab = this.tabs.get(id);
    if (!tab) {
      throw new Error("Missing state for tab id=" + id);
    }
    return tab;
  },
  get activeTabId() {
    for (let [id, tab] of TabsState.tabs) {
      if (tab.active) {
        return id;
      }
    }
    return null;
  }
};

//WindowUtils.on("tabs", "update", TabsState.onEvent.bind(TabsState));

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

  getTabForAddon(tabId) {
    let tab = TabsState.getTabById(tabId);
    // Clone the object so that the callsite can alter its own copy
    // but also to allow us to remove fields requiring special perms
    tab = JSON.parse(JSON.stringify(tab));

    if (!this.hasTabPermission(tab)) {
      delete tab.url;
      delete tab.title;
      delete tab.favIconUrl;
    }

    return tab;
  },

  convert(frame) {
    let tab = TabsState.getTab(frame);
    // Clone the object so that the callsite can alter its own copy
    // but also to allow us to remove fields requiring special perms
    tab = JSON.parse(JSON.stringify(tab));

    if (!this.hasTabPermission(tab)) {
      delete tab.url;
      delete tab.title;
      delete tab.favIconUrl;
    }

    return tab;
  },

  getTabs(window) {
    return Array.from(window.gBrowser.tabs, tab => this.convert(tab));
  },
};


// Overrides TabManager defined in browser/components/extensions/ext-utils.js
// in order to support generic HTML browser
global.TabManager = {
  _tabs: new WeakMap(),

  frames() {
    let frames = function (window) {
      let list = [...window.document.querySelectorAll("iframe")];
      for(let frame of list) {
        // XXX: Only consider frames with data-tab-id attributes
        // /!\ makes assumptions on the HTML
        if (frame.getAttribute("data-tab-id")) {
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

  getId(tab) {
    let id = tab.getAttribute("data-tab-id");
    if (!id) {
      throw new Error("tab without data-tab-id attribute");
    }
    return id;
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
    throw new Error("Unable to find tab with id=" + tabId+"\n");
    return null;
  },

  get activeTab() {
    let id = TabsState.activeTabId;
    if (id) {
      return this.getTab(id);
    }
    return null;
  },

  getStatus(tab) {
    // TODO
    return "complete";
  },

  getTabForAddon(extension, tabId) {
    return TabManager.for(extension).getTabForAddon(tabId);
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
