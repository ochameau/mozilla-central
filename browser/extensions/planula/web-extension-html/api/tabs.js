Cu.import("resource://gre/modules/ExtensionUtils.jsm");
var {
    EventManager,
} = ExtensionUtils;


function getSender(context, target, sender) {
  // The message was sent from a content script to a <browser> element.
  // We can just get the |tab| from |target|.
  if (target.tagName == "IFRAME") {
    // The message came from a content script.
    sender.tab = TabManager.convert(context.extension, target);
  } else if ("tabId" in sender) {
    // The message came from an ExtensionPage. In that case, it should
    // include a tabId property (which is filled in by the page-open
    // listener below).
    sender.tab = TabManager.convert(context.extension, TabManager.getTab(sender.tabId));
    delete sender.tabId;
  }
}

/* eslint-disable mozilla/balanced-listeners */
// This listener fires whenever an extension page opens in a tab
// (either initiated by the extension or the user). Its job is to fill
// in some tab-specific details and keep data around about the
// ExtensionPage.
extensions.on("page-load", (type, page, params, sender, delegate) => {
  if (params.type == "tab" || params.type == "popup") {
    let browser = params.docShell.chromeEventHandler;

    //let parentWindow = browser.ownerDocument.defaultView;
    //page.windowId = WindowManager.getId(parentWindow);

    if (params.type == "tab" && browser.getAttribute("data-tab-id")) {
      page.tabId = sender.tabId = TabManager.getId(browser);
    }

    //pageDataMap.set(page, {tab, parentWindow});
  }

  delegate.getSender = getSender;
});

/*
let tabSelectListeners = new Set();
function onTabSelect(event, {id}) {
  tabSelectListeners.forEach(f => {
    f(id);
  });
}
WindowUtils.on("tabs", "select", onTabSelect);

// XXX This is extremelly weak to have to do setTimeout here.
// What happens is that the WindowUtils.on('tabs', 'update', ...) listener
// of utils.js is registered after this one (because the file is loaded after
// this one).
// It makes things broken as TabsState is living in utils.js. Because of this the
// state of tabs is updated after the onUpdated event has been fired to scripts :/
const { setTimeout } = Cu.import("resource://gre/modules/Timer.jsm", {});
let tabUpdatedListeners = new Set();
function onTabUpdated(event, {id}) {
  tabUpdatedListeners.forEach(f => {
    setTimeout(() => {
      f(id);
    });
  });
}
WindowUtils.on("tabs", "update", onTabUpdated);
*/

extensions.registerSchemaAPI("tabs", (extension, context) => {
  return {
    tabs: {
      onActivated: new EventManager(context, "tabs.onActivated", fire => {
          let listener = (event, tabId) => {
            fire({tabId: tabId, windowId: "TODO"});
          };
          TabsState.addListener(listener);
          return () => {
            TabsState.removeListener(listener);
          };
        }).api(),

      onUpdated: new EventManager(context, "tabs.onUpdated", fire => {
        let listener = (event, tabId) => {
          if (event != "create" && event != "update") {
            return;
          }
          let tab = TabManager.getTabForAddon(extension, tabId);
          fire(tabId,
            {
              status: tab.status
            }, // TODO: fill this object
            tab
          );
        };
        TabsState.addListener(listener);
        return () => {
          TabsState.removeListener(listener);
        };
      }).api(),

      onMoved: new EventManager(context, "tabs.onMoved", fire => {
        // XXX NOT IMPLEMENTED
        return () => {
        };
      }).api(),

      onRemoved: new EventManager(context, "tabs.onRemoved", fire => {
        let listener = (event, tabId) => {
          if (event != "remove") {
            return;
          }
          fire(tabId, { windowId: null, isWindowClosing: false });
        };
        TabsState.addListener(listener);
        return () => {
          TabsState.removeListener(listener);
        };
      }).api(),

      get(tabId) {
        let tab = TabManager.getTab(tabId);
        return Promise.resolve(TabManager.convert(extension, tab));
      },

      update(tabId, properties) {
        dump("chrome.tab.update("+tabId+", "+JSON.stringify(properties)+")\n");
        // ?? some properties are set to null even if the caller didn't pass it...
        // Remove them to not confuse TabsState.
        for(let k in properties) {
          if (properties[k] === null) {
            delete properties[k];
          }
        }
        // If no tabId was given, automatically try to fetch the active tab
        properties.id = tabId || TabsState.activeTabId;
        if (!properties.id) {
          dump("chrome.tab.update() failed as we couldn't find any currently selected tab\n");
          return;
        }
        TabsState.onEvent("update", properties);
      },

      create(properties) {
        // XXX It needs to return a promise with the success/failure of creating
        // a tab. Without that the session restore web extension will have an
        // hard time to work.
        let tabId = TabsState.onEvent("create", properties);
        let tab = TabManager.getTab(tabId);
        return Promise.resolve(TabManager.convert(extension, tab));
      },

      highlight({ tabs }) {
        if (typeof(tabs) == "number") {
          tabs = [tabs];
        }
        for (let tabId of TabsState.tabs.keys()) {
          if (tabs.includes(tabId)) {
            TabsState.onEvent("update", { id: tabId, selected: true, highlighted: true, active: true });
          } else {
            TabsState.onEvent("update", { id: tabId, selected: false, highlighted: false, active: false });
          }
        }
      },

      remove(id) {
        let tab = TabsState.getTabById(id);
        let wasActive = tab.active;

        TabsState.onEvent("remove", { id });

        // If that was an active tab, automatically make the last tab the new active one
        if (wasActive) {
          let last = TabsState.tabs.keys().pop();
          if (last) {
            this.highlight({ tabs: last.id });
          }
        }
      },

      getCurrent() {
        return Promise.resolve(TabManager.convert(extension, TabManager.activeTab));
      },

      // Used to executeScript, insertCSS and removeCSS.
      _execute: function(tabId, details, kind, method) {
        dump("_execute("+tabId+")\n");
        let tab = tabId !== null ? TabManager.getTab(tabId) : TabManager.activeTab;
        // XXX: We only modified this line, otherwise it is just copy paster from ext-tabs.js from browser/ folder.
        let mm = tab.QueryInterface(Ci.nsIFrameLoaderOwner)
                    .frameLoader.messageManager

        let options = {
          js: [],
          css: [],
          remove_css: method == "removeCSS",
        };

        // We require a `code` or a `file` property, but we can't accept both.
        if ((details.code === null) == (details.file === null)) {
          return Promise.reject({message: `${method} requires either a 'code' or a 'file' property, but not both`});
        }

        if (details.frameId !== null && details.allFrames) {
          return Promise.reject({message: `'frameId' and 'allFrames' are mutually exclusive`});
        }

        let recipient = {
          innerWindowID: tab.innerWindowID, //tab.linkedBrowser.innerWindowID,
        };

        if (TabManager.for(extension).hasActiveTabPermission(tab)) {
          // If we have the "activeTab" permission for this tab, ignore
          // the host whitelist.
          options.matchesHost = ["<all_urls>"];
        } else {
          options.matchesHost = extension.whiteListedHosts.serialize();
        }

        if (details.code !== null) {
          options[kind + "Code"] = details.code;
        }
        if (details.file !== null) {
          let url = context.uri.resolve(details.file);
          if (!extension.isExtensionURL(url)) {
            return Promise.reject({message: "Files to be injected must be within the extension"});
          }
          options[kind].push(url);
        }
        if (details.allFrames) {
          options.all_frames = details.allFrames;
        }
        if (details.frameId !== null) {
          options.frame_id = details.frameId;
        }
        if (details.matchAboutBlank) {
          options.match_about_blank = details.matchAboutBlank;
        }
        if (details.runAt !== null) {
          options.run_at = details.runAt;
        } else {
          options.run_at = "document_idle";
        }

        return context.sendMessage(mm, "Extension:Execute", {options}, {recipient});
      },

      executeScript: function(tabId, details) {
        return this._execute(tabId, details, "js", "executeScript");
      },
    },
  };
});
