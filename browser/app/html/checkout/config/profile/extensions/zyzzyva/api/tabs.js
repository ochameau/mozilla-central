
dump("Tabs\n");

Cu.import("resource://webextensions/glue.jsm");
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

    if (params.type == "tab" && browser.getAttribute("uuid")) {
      page.tabId = sender.tabId = TabManager.getId(browser);
    }

    //pageDataMap.set(page, {tab, parentWindow});
  }

  delegate.getSender = getSender;
});

let tabSelectListeners = new Set();
function onTabSelect({uuid}) {
  let tabId = TabManager.getIdForUUID(uuid);
  dump("Tabs.select uuid="+uuid+" id="+tabId+"\n");
  tabSelectListeners.forEach(f => {
    f(tabId);
  });
}
WindowUtils.on("tabs", "select", onTabSelect);

let tabUpdatedListeners = new Set();
function onTabUpdated({uuid}) {
  let tabId = TabManager.getIdForUUID(uuid);
  dump("Tabs.update uuid="+uuid+" id="+tabId+"\n");
  tabUpdatedListeners.forEach(f => {
    f(tabId);
  });
}
WindowUtils.on("tabs", "update", onTabUpdated);

extensions.registerSchemaAPI("tabs", null, (extension, context) => {
  return {
    tabs: {
      onActivated: new EventManager(context, "tabs.onActivated", fire => {
          let listener = tabId => {
            fire({tabId: tabId, windowId: "TODO"});
          };
          tabSelectListeners.add(listener);
          return () => {
            tabSelectListeners.delete(listener);
          };
        }).api(),

      onUpdated: new EventManager(context, "tabs.onUpdated", fire => {
          let listener = tabId => {
            let tab = TabManager.getTab(tabId);
            fire(tabId,
              {}, // TODO: fill this object
              TabManager.convert(extension, tab)
            );
          };
          tabUpdatedListeners.add(listener);
          return () => {
            tabUpdatedListeners.delete(listener);
          };
        }).api(),

      get(tabId) {
        let tab = TabManager.getTab(tabId);
        if (!tab) {
          dump("chromes.tabs.get("+tabId+") no iframe\n");
          // XXX: The tab may not have any iframe yet
          return Promise.resolve({
            id: tabId,
            url: "",
            index: -1,
            windowId: -1,
            selected: true,
            highlighted: true,
            active: true,
            pinned: false,
            status: 0,
            incognito: false,
            width: 0,
            height: 0,
          });
        }
        return Promise.resolve(TabManager.convert(extension, tab));
      },

      update(tabId, updateProperties) {
        let tab = TabManager.getTab(tabId);
        /*
        WindowUtils.emit('tabs', 'navigate', {
        });
        */
      },

      create(createProperties) {
        WindowUtils.emit('tabs', 'add', {
          select: true,
          url: createProperties.url
        });
      },

      _execute: function(tabId, details, kind) {
        let tab = tabId !== null ? TabManager.getTab(tabId) : TabManager.activeTab;
        let mm = tab.QueryInterface(Ci.nsIFrameLoaderOwner)
                    .frameLoader.messageManager

        let options = {
          js: [],
          css: [],
        };

        let recipient = {
          innerWindowID: undefined,
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
        if (details.matchAboutBlank) {
          options.match_about_blank = details.matchAboutBlank;
        }
        if (details.runAt !== null) {
          options.run_at = details.runAt;
        }

        return context.sendMessage(mm, "Extension:Execute", {options}, recipient);
      },

      executeScript: function(tabId, details) {
        return this._execute(tabId, details, "js");
      },

    },
  };
});

dump("Tabs.js: parsed\n");
