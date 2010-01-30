/* See license.txt for terms of usage */

// ************************************************************************************************
// Shorcuts and Services

const Cc = Components.classes;
const Ci = Components.interfaces;

const traceService = Cc["@joehewitt.com/firebug-trace-service;1"].getService(Ci.nsIObserverService);

const PrefService = Cc["@mozilla.org/preferences-service;1"];
const prefs = PrefService.getService(Ci.nsIPrefBranch2);
const prefService = PrefService.getService(Ci.nsIPrefService);

var gFindBar;

const reDBG = /extensions\.([^\.]*)\.(DBG_.*)/;
const reDBG_FBS = /DBG_FBS_(.*)/;
const reEndings = /\r\n|\r|\n/;

// The lib.js isn't included in this window so, define the global here.
// It'll be initialized from window parameters (see initialize method).
var FBL;

// Cache messages that are fired before the content of the window is loaded.
var queue = [];

// ************************************************************************************************
// Trace Window Implementation

var TraceConsole =
{
    modules: [],

    initialize: function()
    {
        var args = window.arguments[0];
        FBL = args.FBL;
        Firebug = args.Firebug;

        // Get pref domain is used for message filtering. Only logs that belong
        // to this pref-domain will be displayed.
        this.prefDomain = args.prefDomain;
        document.title = FBL.$STR("title.Tracing") + ": " + this.prefDomain;

        // Register listeners and observers
        traceService.addObserver(this, "firebug-trace-on-message", false);
        prefs.addObserver(this.prefDomain, this, false);

        // Initialize root node of the trace-console window.
        var consoleFrame = document.getElementById("consoleFrame");
        this.consoleNode = consoleFrame.contentDocument.getElementById("panelNode-traceConsole");
        Firebug.TraceModule.CommonBaseUI.initializeContent(this.consoleNode, this, this.prefDomain,
            FBL.bind(this.initializeContent, this));

        gFindBar = document.getElementById("FindToolbar");
    },

    initializeContent: function(logNode)
    {
        this.logs = logNode;

        // Notify listeners
        Firebug.TraceModule.onLoadConsole(window, logNode);
        this.registerModule(Firebug.TraceModule);

        // Make sure the UI is localized.
        this.internationalizeUI();
        this.updateTimeInfo();

        // If the opener is closed the console must be also closed.
        // (this console uses shared object from the opener (e.g. Firebug)
        window.opener.addEventListener("close", this.onCloseOpener, true);
        this.addedOnCloseOpener = true;

        // Fetch all cached messages.
        for (var i=0; i<queue.length; i++)
            this.dump(queue[i]);
    },

    internationalizeUI: function()
    {
        var buttons = ["clearConsole", "findConsole", "separateConsole",
            "restartFirefox", "closeFirefox", "saveToFile"];

        for (var i=0; i<buttons.length; i++)
        {
            var element = document.getElementById(buttons[i]);
            FBL.internationalize(element, "label");
            FBL.internationalize(element, "tooltiptext");
        }
    },

    updateTimeInfo: function()
    {
        var showTime = Firebug.getPref(this.prefDomain, "trace.showTime");
        if (showTime)
            FBL.setClass(this.logs.firstChild, "showTime");
        else
            FBL.removeClass(this.logs.firstChild, "showTime");
    },

    shutdown: function()
    {
        traceService.removeObserver(this, "firebug-trace-on-message");
        prefs.removeObserver(this.prefDomain, this, false);

        // Notify listeners
        for (var i=0; i<this.modules.length; ++i)
            this.modules[i].onUnloadConsole(window);

        // Unregister from the opener
        if (this.addedOnCloseOpener)
        {
            window.opener.removeEventListener("close", this.onCloseOpener, true);
            delete this.addedOnCloseOpener;
        }
    },

    onCloseOpener: function()
    {
        window.close();
    },

    registerModule: function(traceModule)
    {
        this.modules.push(traceModule);
    },

    unregisterModule: function(module)
    {
        for (var i=0; i<this.modules.length; ++i) {
            if (this.modules[i] == module) {
                this.modules.splice(i, 1);
                break;
            }
        }
    },

    // nsIObserver
    observe: function(subject, topic, data)
    {
        if (topic == "firebug-trace-on-message")
        {
            // Display messages only with "firebug.extensions" type.
            var messageInfo = subject.wrappedJSObject;

            // If the message type isn't specified, use Firebug's pref domain as the default.
            if (!messageInfo.type)
                messageInfo.type = "extensions.firebug";

            if (messageInfo.type != this.prefDomain)
                return;

            var message = new Firebug.TraceModule.TraceMessage(
                messageInfo.type, data, messageInfo.obj, messageInfo.scope,
                messageInfo.time);

            // If the content isn't loaded yet, remember all messages and insert them later.
            if (this.logs)
                this.dump(message);
            else
                queue.push(message);

            return true;
        }
        else if (topic == "nsPref:changed")
        {
            if (data == this.prefDomain + ".trace.showTime")
                this.updateTimeInfo();
        }
    },

    // ********************************************************************************************
    // Interface to the output nodes, going by the name outputNodes
    getScrollingNode: function()
    {
        //window.dump(FBL.getStackDump());
        //window.dump("traceConsole getScrollingNode this.scrollingNode "+this.scrollingNode+"\n");

        return this.scrollingNode;
    },
    setScrollingNode: function(node)
    {
        this.scrollingNode = node;
    },
    getTargetNode: function()
    {
        //window.dump(FBL.getStackDump());
        //window.dump("traceConsole getTargetgNode this.scrollingNode "+this.logs.firstChild+"\n");

        return this.logs.firstChild;
    },
    // ********************************************************************************************
    // Message dump
    dump: function(message)
    {
        // Notify listeners
        for (var i=0; i<this.modules.length; ++i)
            this.modules[i].onDump(message);

        Firebug.TraceModule.dump(message, this);
    },

    dumpSeparator: function()
    {
        Firebug.TraceModule.MessageTemplate.dumpSeparator(this);
    },

    // Trace console toolbar commands
    onClearConsole: function()
    {
        FBL.clearNode(this.logs.firstChild);
    },

    onSeparateConsole: function()
    {
        Firebug.TraceModule.MessageTemplate.dumpSeparator(this);
    },

    onSaveToFile: function()
    {
        try
        {
            var nsIFilePicker = Ci.nsIFilePicker;
            var fp = Cc["@mozilla.org/filepicker;1"].getService(nsIFilePicker);
            fp.init(window, null, nsIFilePicker.modeSave);
            fp.appendFilters(nsIFilePicker.filterAll | nsIFilePicker.filterText);
            fp.filterIndex = 1;
            fp.defaultString = "firebug-tracing-logs.txt";

            var rv = fp.show();
            if (rv == nsIFilePicker.returnOK || rv == nsIFilePicker.returnReplace)
            {
                var foStream = Cc["@mozilla.org/network/file-output-stream;1"]
                    .createInstance(Ci.nsIFileOutputStream);
                foStream.init(fp.file, 0x02 | 0x08 | 0x20, 0666, 0); // write, create, truncate

                var appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
                var currLocale = Firebug.getPref("general.useragent", "locale");

                // Store head info.
                var head = "Firebug: " + Firebug.version + "\n" +
                    appInfo.name + ": " + appInfo.version + ", " +
                    appInfo.platformVersion + ", " +
                    appInfo.appBuildID + ", " + currLocale + "\n" +
                    "Export Date: " + (new Date()).toGMTString() +
                    "\n==========================================\n\n";
                foStream.write(head, head.length);

                // Iterate over all logs and store it into a file.
                var tbody = this.logs.firstChild;
                for (var row = tbody.firstChild; row; row = row.nextSibling)
                    this.saveMessage(row.repObject, foStream);

                foStream.close();
            }
        }
        catch (err)
        {
            alert(err.toString());
        }
    },

    saveMessage: function(message, stream)
    {
        if (!message)
            return;

        var text = message.text;
        text = text ? text.replace(reEndings, "") : "---";
        if (message.type)
            text = "[" + message.type + "] " + text;
        text = (message.index + 1) + ". " + text + "\n"
        stream.write(text, text.length);
        this.saveStackTrace(message, stream);
    },

    saveStackTrace: function(message, stream)
    {
        var stack = message.stack;
        for (var i=0; stack && i<stack.length; i++) {
            var frame = stack[i];
            var text = "      " + frame.fileName + " (" + frame.lineNumber + ")\n";
            stream.write(text, text.length);
        }

        var end = "\n";
        stream.write(end, end.length);
    },

    onRestartFirefox: function()
    {
        Cc["@mozilla.org/toolkit/app-startup;1"].getService(Ci.nsIAppStartup).
            quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);
    },

    onExitFirefox: function()
    {
        goQuitApplication();
    },

};

// ************************************************************************************************
