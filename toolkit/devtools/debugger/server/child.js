Cu.import("resource://gre/modules/Services.jsm");
Cu.import('resource://gre/modules/devtools/dbg-server.jsm');

addMessageListener('debug:connect', function (msg) {
  let mm = msg.target;

  let prefix = msg.data.prefix + docShell.appId;

  if (!DebuggerServer.initialized) {
    DebuggerServer.init();
    DebuggerServer.addActors("chrome://global/content/devtools/dbg-browser-actors.js");
    DebuggerServer.addActors("chrome://global/content/devtools/dbg-webconsole-actors.js");
    DebuggerServer.addTabActor(DebuggerServer.WebConsoleActor, "consoleActor");
    DebuggerServer.addGlobalActor(DebuggerServer.WebConsoleActor, "consoleActor");
    if ("nsIProfiler" in Ci)
      DebuggerServer.addActors("chrome://global/content/devtools/dbg-profiler-actors.js");
  }

  // We have to wait for webbrowser.js to be loaded before fetching BrowserTabActor
  let { BrowserTabActor } = DebuggerServer;

  //XXX: Move ContentTabActor to its own file?

  /**
   * Creates a tab actor for handling requests to the single tab, like
   * attaching and detaching. ContentTabActor respects the actor factories
   * registered with DebuggerServer.addTabActor.
   *
   * @param connection DebuggerServerConnection
   *        The conection to the client.
   * @param browser browser
   *        The browser instance that contains this tab.
   */
  function ContentTabActor(connection, browser)
  {
    BrowserTabActor.call(this, connection, browser);
  }

  ContentTabActor.prototype.constructor = ContentTabActor;

  ContentTabActor.prototype = Object.create(BrowserTabActor.prototype);

  Object.defineProperty(ContentTabActor.prototype, "title", {
    get: function() {
      return this.browser.title;
    },
    enumerable: true,
    configurable: false
  });

  Object.defineProperty(ContentTabActor.prototype, "url", {
    get: function() {
      return this.browser.document.documentURI;
    },
    enumerable: true,
    configurable: false
  });

  Object.defineProperty(ContentTabActor.prototype, "contentWindow", {
    get: function() {
      return this.browser;
    },
    enumerable: true,
    configurable: false
  });

  // Override grip just to rename this._tabActorPool to this._tabActorPool2
  // in order to prevent it to be cleaned on detach.
  // We have to keep tab actors alive as we keep the ContentTabActor
  // alive after detach and reuse it for multiple debug sessions.
  ContentTabActor.prototype.grip = function () {
    let response = {
      'actor': this.actorID,
      'title': this.title,
      'url': this.url
    };

    // Walk over tab actors added by extensions and add them to a new ActorPool.
    let actorPool = new ActorPool(this.conn);
    this._createExtraActors(DebuggerServer.tabActorFactories, actorPool);
    if (!actorPool.isEmpty()) {
      this._tabActorPool2 = actorPool;
      this.conn.addActorPool(this._tabActorPool2);
    }

    this._appendExtraActors(response);
    return response;
  };

  let conn = DebuggerServer.connectToParent(prefix, mm);

  let actor = new ContentTabActor(conn, content);
  let actorPool = new ActorPool(conn);
  actorPool.addActor(actor);
  conn.addActorPool(actorPool);

  sendAsyncMessage("debug:actor", {actor: actor.grip(),
                                   appId: docShell.appId,
                                   prefix: prefix});
});
