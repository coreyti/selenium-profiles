/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const nsIScriptError = Ci.nsIScriptError;
const nsIConsoleMessage = Ci.nsIConsoleMessage;

const WARNING_FLAG = nsIScriptError.warningFlag;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const urlRe = new RegExp("([^:]*):(//)?([^/]*)");
const reUncaught = /uncaught exception/;
const reException = /uncaught exception:\s\[Exception...\s\"([^\"]*)\".*nsresult:.*\(([^\)]*)\).*location:\s\"([^\s]*)\sLine:\s(\d*)\"/;
const statusBar = $("fbStatusBar");
const statusText = $("fbStatusText");

const pointlessErrors =
{
    "uncaught exception: Permission denied to call method Location.toString": 1,
    "uncaught exception: Permission denied to get property Window.writeDebug": 1,
    "uncaught exception: Permission denied to get property XULElement.accessKey": 1,
    "this.docShell has no properties": 1,
    "aDocShell.QueryInterface(Components.interfaces.nsIWebNavigation).currentURI has no properties": 1,
    "Deprecated property window.title used. Please use document.title instead.": 1,
    "Key event not available on GTK2:": 1
};

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const fbs = Cc["@joehewitt.com/firebug;1"].getService().wrappedJSObject;
const consoleService = CCSV("@mozilla.org/consoleservice;1", "nsIConsoleService");

// ************************************************************************************************

var Errors = Firebug.Errors = extend(Firebug.Module,
{
    dispatchName: "errors",
    clear: function(context)
    {
        this.setCount(context, 0); // reset the UI counter
        delete context.errorMap;   // clear the duplication-removal table
    },

    increaseCount: function(context)
    {
        this.setCount(context, context.errorCount + 1)
    },

    setCount: function(context, count)
    {
        context.errorCount = count;

        if (context == FirebugContext)
            this.showCount(context.errorCount);
    },

    showMessageOnStatusBar: function(error)
    {
        if (statusText && statusBar && Firebug.breakOnErrors && error.message &&  !(error.flags & WARNING_FLAG))  // sometimes statusText is undefined..how?
        {
            statusText.setAttribute("value", error.message);
            statusBar.setAttribute("errors", "true");
        }
    },

    showCount: function(errorCount)
    {
        if (!statusBar)
            return;

        if (errorCount)
        {
            if (Firebug.showErrorCount)
            {
                var errorLabel = errorCount > 1
                    ? $STRF("ErrorsCount", [errorCount])
                    : $STRF("ErrorCount", [errorCount]);

                statusText.setAttribute("value", errorLabel);
            }

            statusBar.setAttribute("errors", "true");
        }
        else
        {
            statusText.setAttribute("value", "");
            statusBar.removeAttribute("errors");
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Called by Console

    startObserving: function()
    {
        this.contextCache = [];
        consoleService.registerListener(this);
    },

    stopObserving: function()
    {
        consoleService.unregisterListener(this);
        delete this.contextCache;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends consoleListener

    observe: function(object)
    {
        try
        {
            if (window.closed)
                this.stopObserving();
            if (!FBTrace)
                return;
        }
        catch(exc)
        {
            return;
        }

        try
        {
            if (object instanceof nsIScriptError)  // all branches should trace 'object'
            {
                var context = this.getErrorContext(object);  // after instanceof
                var isWarning = object.flags & WARNING_FLAG;  // This cannot be pulled in front of the instanceof
                context = this.logScriptError(context, object, isWarning);
                if(!context)
                    return;
            }
            else
            {
                var isWarning = object.flags & WARNING_FLAG;
                if (Firebug.showChromeMessages)
                {
                    if (object instanceof nsIConsoleMessage)
                    {
                        var context = this.getErrorContext(object);  // after instanceof
                        if (lessTalkMoreAction(context, object, isWarning))
                            return;
                        if (context)
                            Firebug.Console.log(object.message, context, "consoleMessage", FirebugReps.Text);
                    }
                    else if (object.message)
                    {
                        var context = this.getErrorContext(object);
                        if (context)  // maybe just FirebugContext
                            Firebug.Console.log(object.message, context, "consoleMessage", FirebugReps.Text);
                        else
                            FBTrace.sysout("errors.observe, no context for message", object);
                    }
                    else
                        FBTrace.sysout("errors.observe, no message in object", object);
                }
                else
                {
                    return;
                }
            }
        }
        catch (exc)
        {
            // Errors prior to console init will come out here, eg error message from Firefox startup jjb.
        }
    },

    logScriptError: function(context, object, isWarning)
    {
        if (!context)
            return;

        var category = getBaseCategory(object.category);
        var isJSError = category == "js" && !isWarning;

        if (Firebug.showStackTrace && Firebug.errorStackTrace)
        {
            var trace = Firebug.errorStackTrace;
            trace = this.correctLineNumbersWithStack(trace, object) ? trace : null;
        }
        else if (checkForUncaughtException(context, object))
        {
            context = getExceptionContext(context);
            object = correctLineNumbersOnExceptions(context, object);
        }

        if (lessTalkMoreAction(context, object, isWarning))
            return null;

        Firebug.errorStackTrace = null;  // clear global: either we copied it or we don't use it.

        if (!isWarning)
            this.increaseCount(context);

        var error = new ErrorMessage(object.errorMessage, object.sourceName,
            object.lineNumber, object.sourceLine, category, context, trace);  // the sourceLine will cause the source to be loaded.

        var className = isWarning ? "warningMessage" : "errorMessage";

        if (context)
        {
            context.throttle(Firebug.Console.log, Firebug.Console, [error, context,  className, false, true], true);
        }
        else
        {
            Firebug.Console.log(error, FirebugContext,  className);
        }
        return context;
    },

    correctLineNumbersWithStack: function(trace, object)
    {
        var stack_frame = trace.frames[0];
        if (stack_frame)
        {
            var sourceName = stack_frame.href;
            var lineNumber = stack_frame.lineNo;

            var correctedError =
            {
                    errorMessage: object.errorMessage,
                    dsourceName: sourceName,
                    sourceLine: object.sourceLine,
                    lineNumber: lineNumber,
                    columnNumber: object.columnNumber,
                    flags: object.flags,
                    categor: object.category
            };
            object = correctedError;

            return true;
        }
        return false;
    },

    getErrorContext: function(object)
    {
        var url = object.sourceName;
        if(!url)
            return FirebugContext;  // eg some XPCOM messages

        var errorContext = this.contextCache[url];

        if (errorContext)
            return errorContext;

        TabWatcher.iterateContexts(
            function findContextByURL(context)
            {
                if (errorContext) // is it faster to keep iterating or throw to abort iterator?
                    return;

                if (!context.window || !context.getWindowLocation())
                    return;

                if (context.getWindowLocation().toString() == url)
                    return errorContext = context;
                else
                {
                    if (context.sourceFileMap && context.sourceFileMap[url])
                        return errorContext = context;
                }

                if (FBL.getStyleSheetByHref(url, context))
                    return errorContext = context;
            }
        );

        if (errorContext)
            this.contextCache[url] = errorContext;

        if (!errorContext)
            errorContext = FirebugContext;  // this is problem if the user isn't viewing the page with errors

        return errorContext; // we looked everywhere...
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Module

    initContext: function(context)
    {
        context.errorCount = 0;
    },

    showContext: function(browser, context)
    {
        this.showCount(context ? context.errorCount : 0);
    },

    unwatchWindow: function(context, win)  // called for top window and frames.
    {
        this.clear(context);  // If we ever get errors by window from Firefox we can cache by window.
    },

    destroyContext: function(context, persistedState)
    {
        for (var url in this.contextCache)
        {
            if (this.contextCache[url] == context)
                delete this.contextCache[url];
        }
        this.showCount(0);
    },
    // ******************************************************************************

    reparseXPC: function(errorMessage, context)
    {
        var reXPCError = /JavaScript Error:\s*\"([^\"]*)\"/;
        var reFile = /file:\s*\"([^\"]*)\"/;
        var reLine = /line:\s*(\d*)/;
        var m = reXPCError.exec(errorMessage);
        if (!m)
            return null;
        var msg = m[1];

        var sourceFile = null;
        m = reFile.exec(errorMessage);
        if (m)
            sourceFile = m[1];

        var sourceLineNo = 0;
        m = reLine.exec(errorMessage);
        if (m)
            sourceLineNo = m[1];

        var sourceLine = null;
        if (sourceFile && sourceLineNo && sourceLineNo != 0)
            sourceLine = context.sourceCache.getLine(sourceFile, sourceLineNo);

        var error = new ErrorMessage(msg, sourceFile,
                sourceLineNo, sourceLine, "error", context, null);
        return error;
    }
});

// ************************************************************************************************
// Local Helpers

const categoryMap =
{
    "javascript": "js",
    "JavaScript": "js",
    "DOM": "js",
    "Events": "js",
    "CSS": "css",
    "XML": "xml",
    "malformed-xml": "xml"
};

function getBaseCategory(categories)
{
    var categoryList = categories.split(" ");
    for (var i = 0 ; i < categoryList.length; ++i)
    {
        var category = categoryList[i];
        if ( categoryMap.hasOwnProperty(category) )
            return categoryMap[category];
    }
}

function whyNotShown(url, category, isWarning)
{
    var m = urlRe.exec(url);
    var errorScheme = m ? m[1] : "";
    if (errorScheme == "javascript")
        return null;

    var isChrome = false;

    if (!category)
        return Firebug.showChromeErrors ? null :"no category, assume chrome, showChromeErrors false";

    var categories = category.split(" ");
    for (var i = 0 ; i < categories.length; ++i)
    {
        var category = categories[i];
        if (category == "CSS" && !Firebug.showCSSErrors)
            return "showCSSErrors";
        else if ((category == "XML" || category == "malformed-xml" ) && !Firebug.showXMLErrors)
            return "showXMLErors";
        else if ((category == "javascript" || category == "JavaScript" || category == "DOM")
                    && !isWarning && !Firebug.showJSErrors)
            return "showJSErrors";
        else if ((category == "javascript" || category == "JavaScript" || category == "DOM")
                    && isWarning && !Firebug.showJSWarnings)
            return "showJSWarnings";
        else if (errorScheme == "chrome" || category == "XUL" || category == "chrome" || category == "XBL"
                || category == "component")
            isChrome = true;
    }

    if ((isChrome && !Firebug.showChromeErrors))
        return "showChromeErrors";

    return null;
}

function domainFilter(url)  // never called?
{
    if (Firebug.showExternalErrors)
        return true;

    var browserWin = document.getElementById("content").contentWindow;

    var m = urlRe.exec(browserWin.location.href);
    if (!m)
        return false;

    var browserDomain = m[3];

    m = urlRe.exec(url);
    if (!m)
        return false;

    var errorScheme = m[1];
    var errorDomain = m[3];

    return errorScheme == "javascript"
        || errorScheme == "chrome"
        || errorDomain == browserDomain;
}

function lessTalkMoreAction(context, object, isWarning)
{
    if (!context)
    {
        return false;
    }

    var enabled = Firebug.Console.isAlwaysEnabled();
    if (!enabled) {
        FBTrace.sysout("errors.observe not enabled for context "+(context.window?context.window.location:"no window")+"\n");
        return true;
    }

    var why = whyNotShown(object.sourceName, object.category, isWarning);

    if (why)
    {
        return true;
    }

    var incoming_message = object.errorMessage;  // nsIScriptError
    if (!incoming_message)                       // nsIConsoleMessage
        incoming_message = object.message;

    if (Firebug.suppressPointlessErrors)
    {
        for (var msg in pointlessErrors)
        {

            if( msg.charAt(0) == incoming_message.charAt(0) )
            {
                if (incoming_message.indexOf(msg) == 0)
                {
                    return true;
                }
            }
        }
    }

    var msgId = [incoming_message, object.sourceName, object.lineNumber].join("/");
    if (context.errorMap && msgId in context.errorMap)
    {
        context.errorMap[msgId] += 1;
        return true;
    }

    if (!context.errorMap)
        context.errorMap = {};

    context.errorMap[msgId] = 1;

    return false;
}

function checkForUncaughtException(context, object)
{
    if (object.flags & object.exceptionFlag)
    {
        if (reUncaught.test(object.errorMessage))
        {
            if (context.thrownStackTrace)
            {
                Firebug.errorStackTrace = context.thrownStackTrace;
                delete context.thrownStackTrace;
            }
            else
            {
            }
            return true;
        }
        else
        {
        }
    }
    delete context.thrownStackTrace;
    return false;
}

function getExceptionContext(context)
{
    var errorWin = fbs.lastErrorWindow;  // not available unless Script panel is enabled.
    if (errorWin)
    {
        var errorContext = TabWatcher.getContextByWindow(errorWin);
        if (errorContext)
            return errorContext;
    }
    return context;
}

function correctLineNumbersOnExceptions(context, object)
{
    var m = reException.exec(object.errorMessage);
    if (m)
    {
        var exception = m[1];
        if (exception)
            errorMessage = "uncaught exception: "+exception;
        var nsresult = m[2];
        if (nsresult)
            errorMessage += " ("+nsresult+")";
        var sourceName = m[3];
        var lineNumber = parseInt(m[4]);

        var correctedError =
        {
                errorMessage: object.errorMessage,
                sourceName: sourceName,
                sourceLine: object.sourceLine,
                lineNumber: lineNumber,
                columnNumber: object.columnNumber,
                flags: object.flags,
                category: object.category
        };

        return correctedError;
    }
    else
        return object;
}

// ************************************************************************************************

Firebug.registerModule(Errors);

// ************************************************************************************************

}});
