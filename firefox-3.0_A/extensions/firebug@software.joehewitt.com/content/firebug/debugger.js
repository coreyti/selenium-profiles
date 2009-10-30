/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const jsdIScript = Ci.jsdIScript;
const jsdIStackFrame = Ci.jsdIStackFrame;
const jsdIExecutionHook = Ci.jsdIExecutionHook;
const nsISupports = Ci.nsISupports;
const nsICryptoHash = Ci.nsICryptoHash;
const nsIURI = Ci.nsIURI;

const PCMAP_SOURCETEXT = jsdIScript.PCMAP_SOURCETEXT;
const PCMAP_PRETTYPRINT = jsdIScript.PCMAP_PRETTYPRINT;

const RETURN_VALUE = jsdIExecutionHook.RETURN_RET_WITH_VAL;
const RETURN_THROW_WITH_VAL = jsdIExecutionHook.RETURN_THROW_WITH_VAL;
const RETURN_CONTINUE = jsdIExecutionHook.RETURN_CONTINUE;
const RETURN_CONTINUE_THROW = jsdIExecutionHook.RETURN_CONTINUE_THROW;
const RETURN_ABORT = jsdIExecutionHook.RETURN_ABORT;

const TYPE_THROW = jsdIExecutionHook.TYPE_THROW;

const STEP_OVER = 1;
const STEP_INTO = 2;
const STEP_OUT = 3;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const tooltipTimeout = 300;

const reLineNumber = /^[^\\]?#(\d*)$/;

const reEval =  /\s*eval\s*\(([^)]*)\)/m;        // eval ( $1 )
const reHTM = /\.[hH][tT][mM]/;
const reFunction = /\s*Function\s*\(([^)]*)\)/m;

// ************************************************************************************************

Firebug.Debugger = extend(Firebug.ActivableModule,
{
    dispatchName: "debugger",

    fbs: fbs, // access to firebug-service in chromebug under browser.xul.DOM.Firebug.Debugger.fbs /*@explore*/
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Debugging

    evaluate: function(js, context, scope)
    {
        var frame = context.currentFrame;
        if (!frame)
            return;

        frame.scope.refresh(); // XXX what's this do?

        var result = {};
        var scriptToEval = js;

        // This seem to be safe; eval'ing a getter property in content that tries to
        // be evil and get Components.classes results in a permission denied error.
        var ok = frame.eval(scriptToEval, "", 1, result);

        var value = result.value.getWrappedValue();
        if (ok)
            return value;
        else
            throw value;
    },

    getCurrentFrameKeys: function(context)
    {
        var globals = keys(context.getGlobalScope().wrappedJSObject);  // return is safe

        if (context.currentFrame)
            return this.getFrameKeys(context.currentFrame, globals);

        return globals;
    },

    getFrameKeys: function(frame, names)
    {
        var listValue = {value: null}, lengthValue = {value: 0};
        frame.scope.getProperties(listValue, lengthValue);

        for (var i = 0; i < lengthValue.value; ++i)
        {
            var prop = listValue.value[i];
            var name = prop.name.getWrappedValue();
            names.push(name);
        }
        return names;
    },

    focusWatch: function(context)
    {
        if (Firebug.isDetached())
            Firebug.chrome.focus();
        else
            Firebug.toggleBar(true);

        Firebug.chrome.selectPanel("script");

        var watchPanel = context.getPanel("watches", true);
        if (watchPanel)
        {
            Firebug.CommandLine.isReadyElsePreparing(context);
            watchPanel.editNewWatch();
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    beginInternalOperation: function() // stop debugger operations like breakOnErrors
    {
        var state = {breakOnErrors: Firebug.breakOnErrors};
        Firebug.breakOnErrors = false;
        return state;
    },

    endInternalOperation: function(state)  // pass back the object given by beginInternalOperation
    {
        Firebug.breakOnErrors = state.breakOnErrors;
        return true;
    },
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    halt: function(fn)
    {
        this.haltCallback = fn; // called in this.onHalt as fn(frame);
        fbs.halt(this);

        debuggerHalter(); // a function with a URL that passes jsdIFilter

        if (this.haltCallback) // so we have a second try
        {
            FBTrace.sysout("debugger did not halt jsd: ", jsd);
            if (Firebug.CommandLine.isReadyElsePreparing(FirebugContext))
                Firebug.CommandLine.evaluate("debugger;", FirebugContext);
        }

    },

    stop: function(context, frame, type, rv)
    {
        if (context.stopped)
            return RETURN_CONTINUE;

        if (!this.isAlwaysEnabled())
            return RETURN_CONTINUE;

        var executionContext;
        try
        {
            executionContext = frame.executionContext;
        }
        catch (exc)
        {
            return RETURN_CONTINUE;
        }

        context.debugFrame = frame;
        context.stopped = true;

        var hookReturn = dispatch2(this.fbListeners,"onStop",[context,frame, type,rv]);
        if ( hookReturn && hookReturn >= 0 )
        {
            delete context.stopped;
            delete context.debugFrame;
            delete context;
            return hookReturn;
        }

        try {
            executionContext.scriptsEnabled = false;

            cacheAllScripts(context);

        } catch (exc) {
            // This attribute is only valid for contexts which implement nsIScriptContext.
        }

        try
        {
            // We will pause here until resume is called
            var depth = fbs.enterNestedEventLoop({onNest: bindFixed(this.startDebugging, this, context)});
            // For some reason we don't always end up here
        }
        catch (exc)
        {
            // Just ignore exceptions that happened while in the nested loop
        }

        try {
            if (executionContext.isValid)
            {
                executionContext.scriptsEnabled = true;
            }
            else
            {
            }

        } catch (exc) {
        }

        this.stopDebugging(context);

        dispatch(this.fbListeners,"onResume",[context]);

        if (this.aborted)
        {
            delete this.aborted;
            return RETURN_ABORT;
        }
        else
            return RETURN_CONTINUE;
    },

    resume: function(context)
    {
        if (!context.stopped) // then resume means breakOnNext
        {
            try
            {
                this.breakOnNext(context);
            }
            catch (exc)
            {
            }
            return;
        }

        // in fbs we stopStepping() so allow breakOnNext again
        Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "true");
        Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "tooltiptext", $STR("script.Break On Next"));

        delete context.stopped;
        delete context.debugFrame;
        delete context.currentFrame;
        delete context;

        var depth = fbs.exitNestedEventLoop();
    },

    breakOnNext: function(context)
    {
        if (!context || !Firebug.chrome)
            return;

        var breakable = Firebug.chrome.getGlobalAttribute("cmd_resumeExecution", "breakable").toString();

        if (breakable == "disabled")
            return;
        else if (breakable == "true")
            this.suspend(context);  // arm breakOnNext
        else {
            Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "true");  // was armed, undo
            Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "tooltiptext", $STR("script.Break On Next"));
        }
        this.syncCommands(context);
        return;
    },

    onBreakingNext: function(debuggr, context)
    {
        var chrome = Firebug.chrome;
        chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "false");  // mark armed
        Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "tooltiptext", $STR("DisableBreakOnNext"));
    },

    abort: function(context)
    {
        if (context.stopped)
        {
            context.aborted = true;
            this.resume(context);
        }
    },

    stepOver: function(context)
    {
        if (!context.debugFrame || !context.debugFrame.isValid)
            return;

        fbs.step(STEP_OVER, context.debugFrame, this);
        this.resume(context);
    },

    stepInto: function(context)
    {
        if (!context.debugFrame || !context.debugFrame.isValid)
            return;

        fbs.step(STEP_INTO, context.debugFrame, this);
        this.resume(context);
    },

    stepOut: function(context)
    {
        if (!context.debugFrame || !context.debugFrame.isValid)
            return;

        fbs.step(STEP_OUT, context.debugFrame);
        this.resume(context);
    },

    suspend: function(context)
    {
        if (context.stopped)
            return;
        fbs.suspend(this, context);
    },

    runUntil: function(context, sourceFile, lineNo)
    {
        if (!context.debugFrame || !context.debugFrame.isValid)
            return;

        fbs.runUntil(sourceFile, lineNo, context.debugFrame, this);
        this.resume(context);
    },


    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Breakpoints

    setBreakpoint: function(sourceFile, lineNo)
    {
        fbs.setBreakpoint(sourceFile, lineNo, null, Firebug.Debugger);
    },

    clearBreakpoint: function(sourceFile, lineNo)
    {
        fbs.clearBreakpoint(sourceFile.href, lineNo);
    },

    setErrorBreakpoint: function(sourceFile, line)
    {
        fbs.setErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    clearErrorBreakpoint: function(sourceFile, line)
    {
        fbs.clearErrorBreakpoint(sourceFile.href, line, Firebug.Debugger);
    },

    enableErrorBreakpoint: function(sourceFile, line)
    {
        fbs.enableErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    disableErrorBreakpoint: function(sourceFile, line)
    {
        fbs.disableErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    clearAllBreakpoints: function(context)
    {
        if (context)
        {
            var sourceFiles = sourceFilesAsArray(context.sourceFileMap);
            fbs.clearAllBreakpoints(sourceFiles, Firebug.Debugger);
        }
        else
        {
            fbs.enumerateBreakpoints(null, {call: function(url, lineNo) // null means all urls
            {
                if (Firebug.filterSystemURLs) // then there are not system urls, clear all
                    fbs.clearBreakpoint(url, lineNo);
                else
                {
                    if (!isSystemURL(url))  // if there are system urls, leave them
                        fbs.clearBreakpoint(url, lineNo);
                }
            }});
        }
    },

    enableAllBreakpoints: function(context)
    {
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
            {
                fbs.enableBreakpoint(url, lineNo);
            }});
        }
    },

    disableAllBreakpoints: function(context)
    {
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
            {
                fbs.disableBreakpoint(url, lineNo);
            }});
        }
    },

    getBreakpointCount: function(context)
    {
        var count = 0;
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url,
            {
                call: function(url, lineNo)
                {
                    ++count;
                }
            });

            fbs.enumerateErrorBreakpoints(url,
            {
                call: function(url, lineNo)
                {
                    ++count;
                }
            });
        }
        return count;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Debugging and monitoring

    traceAll: function(context)
    {
        fbs.traceAll(sourceURLsAsArray(context), this);
    },

    untraceAll: function(context)
    {
        fbs.untraceAll(this);
    },

    monitorFunction: function(fn, mode)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(FirebugContext, fn);
            if (script)
                this.monitorScript(fn, script, mode);
        }
    },

    unmonitorFunction: function(fn, mode)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(FirebugContext, fn);
            if (script)
                this.unmonitorScript(fn, script, mode);
        }
    },

    monitorScript: function(fn, script, mode)
    {
        var scriptInfo = getSourceFileAndLineByScript(FirebugContext, script);
        if (scriptInfo)
        {
            if (mode == "debug")
                this.setBreakpoint(scriptInfo.sourceFile, scriptInfo.lineNo, null, this);
            else if (mode == "monitor")
                fbs.monitor(scriptInfo.sourceFile, scriptInfo.lineNo, Firebug.Debugger);
        }
    },

    unmonitorScript: function(fn, script, mode)
    {
        var scriptInfo = getSourceFileAndLineByScript(FirebugContext, script);
        if (scriptInfo)
        {
            if (mode == "debug")
                this.clearBreakpoint(scriptInfo.sourceFile, scriptInfo.lineNo);
            else if (mode == "monitor")
                fbs.unmonitor(scriptInfo.sourceFile, scriptInfo.lineNo);
        }
    },

    traceCalls: function(context, fn)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(context, fn);
            if (script)
                this.traceScriptCalls(context, script);
            else
            {
            }
        }
    },

    untraceCalls: function(context, fn)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(context, fn);
            if (script)
                this.untraceScriptCalls(context, script);
        }
    },

    traceScriptCalls: function(context, script)
    {
        var scriptInfo = getSourceFileAndLineByScript(context, script);
        if (scriptInfo)
            fbs.traceCalls(scriptInfo.sourceFile, scriptInfo.lineNo, Firebug.Debugger);
    },

    untraceScriptCalls: function(context, script)
    {
        var scriptInfo = getSourceFileAndLineByScript(context, script);
        if (scriptInfo)
            fbs.untraceCalls(scriptInfo.sourceFile, scriptInfo.lineNo, Firebug.Debugger);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // UI Stuff

    startDebugging: function(context)
    {
        try {
            fbs.lockDebugger();

            context.currentFrame = context.debugFrame;

            context.executingSourceFile = FBL.getSourceFileByScript(context, context.currentFrame.script);

            if (!context.executingSourceFile)  // bail out, we don't want the user stuck in debug with out source.
            {
                this.resume(context);
                return;
            }

            if (context != FirebugContext || Firebug.isDetached())
            {
                Firebug.showContext(context.browser, context);  // Make FirebugContext = context and sync the UI
            }

            this.syncCommands(context);
            this.syncListeners(context);

            Firebug.chrome.select(context.currentFrame, "script", null, true);
            Firebug.chrome.focus();
        }
        catch(exc)
        {
            Firebug.Console.log("Resuming debugger: error during debugging loop: "+exc);
            this.resume(context);
        }

        dispatch(this.fbListeners, "onStartDebugging", [context]);

    },

    stopDebugging: function(context)
    {
        try
        {
            fbs.unlockDebugger();

            // If the user reloads the page while the debugger is stopped, then
            // the current context will be destroyed just before
            if (context && context.window && !context.aborted)
            {
                var chrome = Firebug.chrome;

                //if ( chrome.updateViewOnShowHook )
                //    delete chrome.updateViewOnShowHook;

                this.syncCommands(context);
                this.syncListeners(context);

                chrome.syncSidePanels();

                var panel = context.getPanel("script", true);
                if (panel && panel == Firebug.chrome.getSelectedPanel())
                    panel.showNoStackFrame(); // unhighlight and remove toolbar-status line

                context.executingSourceFile = null;
            }
        }
        catch (exc)
        {
            ERROR(exc);
        }
    },

    syncCommands: function(context)
    {
        var chrome = Firebug.chrome;
        if (!chrome)
        {
            return;
        }

        if (context.stopped)
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "true");
            chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "off");
            Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "tooltiptext", $STR("Continue"));
            chrome.setGlobalAttribute("cmd_stepOver", "disabled", "false");
            chrome.setGlobalAttribute("cmd_stepInto", "disabled", "false");
            chrome.setGlobalAttribute("cmd_stepOut", "disabled", "false");
        }
        else
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "false");
            chrome.setGlobalAttribute("cmd_stepOver", "disabled", "true");
            chrome.setGlobalAttribute("cmd_stepInto", "disabled", "true");
            chrome.setGlobalAttribute("cmd_stepOut", "disabled", "true");

            var breakable = chrome.getGlobalAttribute("cmd_resumeExecution", "breakable").toString();
            if (breakable == "true")
                chrome.setGlobalAttribute("cmd_resumeExecution", "tooltiptext",
                    $STR("script.Break On Next"));

            var panel = chrome.getSelectedPanel();
            if (panel && panel.name != "script") // take down the disabled buttons altogether
                panel.showToolbarButtons("fbDebuggerButtons", false);
        }
    },

    syncListeners: function(context)
    {
        var chrome = Firebug.chrome;

        if (context.stopped)
            this.attachListeners(context, chrome);
        else
            this.detachListeners(context, chrome);
    },

    attachListeners: function(context, chrome)
    {
        this.keyListeners =
        [
            chrome.keyCodeListen("F8", null, bind(this.resume, this, context), true),
            chrome.keyListen("/", isControl, bind(this.resume, this, context)),
            chrome.keyCodeListen("F10", null, bind(this.stepOver, this, context), true),
            chrome.keyListen("'", isControl, bind(this.stepOver, this, context)),
            chrome.keyCodeListen("F11", null, bind(this.stepInto, this, context)),
            chrome.keyListen(";", isControl, bind(this.stepInto, this, context)),
            chrome.keyCodeListen("F11", isShift, bind(this.stepOut, this, context)),
            chrome.keyListen(",", isControlShift, bind(this.stepOut, this, context))
        ];
    },

    detachListeners: function(context, chrome)
    {
        if (this.keyListeners)
        {
            for (var i = 0; i < this.keyListeners.length; ++i)
                chrome.keyIgnore(this.keyListeners[i]);
            delete this.keyListeners;
        }
    },

    showPanel: function(browser, panel)
    {
        if (panel && panel.name == "script")
        {
            this.syncCommands(panel.context);
            this.ableWatchSidePanel(panel.context);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // These are XUL window level call backs and should be moved into Firebug where is says nsIFirebugClient

    onPauseJSDRequested: function(rejection)
    {
        if (FirebugContext)  // then we are active in this browser.xul
            rejection.push(true); // so reject the suspend

        dispatch2(this.fbListeners, "onPauseJSDRequested", [rejection]);
    },

    onJSDActivate: function(jsd, why)  // just before hooks are set
    {
        var active = this.setIsJSDActive();

        dispatch2(this.fbListeners,"onJSDActivate",[fbs, why]);
    },

    onJSDDeactivate: function(jsd, why)
    {
        var active = this.setIsJSDActive();

        dispatch2(this.fbListeners,"onJSDDeactivate",[fbs, why]);
    },

    setIsJSDActive: function()  // should only be call on the jsd activation events, so it correctly reflects jsd state
    {
        var active = fbs.isJSDActive();
        if (active)
            $('fbStatusIcon').setAttribute("script", "on");
        else
            $('fbStatusIcon').setAttribute("script", "off");

        return active;
    },

    suspendFirebug: function()
    {
        Firebug.suspendFirebug();
    },

    resumeFirebug: function()
    {
        Firebug.resumeFirebug();
    },
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    supportsWindow: function(win)
    {
        if (!this.isAlwaysEnabled())
            return false;

        var context = ( (win && TabWatcher) ? TabWatcher.getContextByWindow(win) : null);

        this.breakContext = context;
        return !!context;
    },

    supportsGlobal: function(frameWin) // This is call from fbs for almost all fbs operations
    {
        var context = ( (frameWin && TabWatcher) ? TabWatcher.getContextByWindow(frameWin) : null);

        if (context)
        {
            // Apparently the frameWin is a XPCSafeJSObjectWrapper that looks like a Window.
            // Since this is method called a lot make a hacky fast check on _getFirebugConsoleElement
            if (!frameWin._getFirebugConsoleElement)
            {
                if (context.notificationSourceFile)
                {
                    delete context.sourceFileMap[context.notificationSourceFile.href];
                    delete context.notificationSourceFile;
                }
                if (Firebug.Console.isAlwaysEnabled())
                {
                    // This is how the console is injected ahead of JS running on the page
                    fbs.filterConsoleInjections = true;
                    try
                    {
                        var consoleReady = Firebug.Console.isReadyElsePreparing(context, frameWin);
                    }
                    catch(exc)
                    {
                    }
                    finally
                    {
                        fbs.filterConsoleInjections = false;
                    }
                }
                else
                {
                }
            }
            else
            {
            }
        }

        this.breakContext = context;
        return !!context;
    },

    onLock: function(state)
    {
        // XXXjoe For now, trying to see if it's ok to have multiple contexts
        // debugging simultaneously - otherwise we need this
        //if (this.context != this.debugContext)
        {
            // XXXjoe Disable step/continue buttons
        }
    },

    onBreak: function(frame, type)
    {
        try {
            var context = this.breakContext;
            delete this.breakContext;

            if (!context)
            {
                context = getFrameContext(frame);
            }
            if (!context)
                return RETURN_CONTINUE;

            return this.stop(context, frame, type);
        }
        catch (exc)
        {
            throw exc;
        }
    },

    onHalt: function(frame)
    {
        var callback = this.haltCallback;
        delete this.haltCallback;

        if (callback)
            callback(frame);

        return RETURN_CONTINUE;
    },

    onThrow: function(frame, rv)
    {
        // onThrow is called for throw and for any catch that does not succeed.
        var context = this.breakContext;
        delete this.breakContext;

        if (!context)
        {
            FBTrace.sysout("debugger.onThrow, no context, try to get from frame\n");
            context = getFrameContext(frame);
        }
        if (!context)
            return RETURN_CONTINUE_THROW;

        if (!fbs.trackThrowCatch)
            return RETURN_CONTINUE_THROW;

        try
        {
            var isCatch = this.isCatchFromPreviousThrow(frame, context);
            if (!isCatch)
            {
                context.thrownStackTrace = getStackTrace(frame, context);
            }
            else
            {
            }
        }
        catch  (exc)
        {
            FBTrace.sysout("onThrow FAILS: "+exc+"\n");
        }

        if (dispatch2(this.fbListeners,"onThrow",[context, frame, rv]))
            return this.stop(context, frame, TYPE_THROW, rv);
        return RETURN_CONTINUE_THROW;
    },

    isCatchFromPreviousThrow: function(frame, context)
    {
        if (context.thrownStackTrace)
        {
            var trace = context.thrownStackTrace.frames;
            if (trace.length > 1)  // top of stack is [0]
            {
                var curFrame = frame;
                var curFrameSig = curFrame.script.tag +"."+curFrame.pc;
                for (var i = 1; i < trace.length; i++)
                {
                    var preFrameSig = trace[i].signature();
                    if (curFrameSig == preFrameSig)
                    {
                        return true;  // catch from previous throw (or do we need to compare whole stack?
                    }
                }
                // We looked at the previous stack and did not match the current frame
            }
        }
       return false;
    },

    onMonitorScript: function(frame)
    {
        var context = this.breakContext;
        delete this.breakContext;

        if (!context)
            context = getFrameContext(frame);
        if (!context)
            return RETURN_CONTINUE;

        frame = getStackFrame(frame, context);

        dispatch(this.fbListeners,"onMonitorScript",[context, frame]);
    },

    onFunctionCall: function(context, frame, depth, calling)
    {
        if (!context)
            context = getFrameContext(frame);
        if (!context)
            return RETURN_CONTINUE;

        frame = getStackFrame(frame, context);

        dispatch(this.fbListeners,"onFunctionCall",[context, frame, depth, calling]);

        return context;  // returned as first arg on next call from same trace
    },

    onError: function(frame, error)
    {
        var context = this.breakContext;
        delete this.breakContext;

        try
        {
            Firebug.errorStackTrace = getStackTrace(frame, context);
            if (Firebug.breakOnErrors)
                context.breakingError = error;
            else
                delete context.breakingError;
        }
        catch (exc) {
        }

        var hookReturn = dispatch2(this.fbListeners,"onError",[context, frame, error]);

        if (Firebug.breakOnErrors)
            return -1;  // break

        if (hookReturn)
            return hookReturn;

        return -2; /* let firebug service decide to break or not */
    },

    onEvalScriptCreated: function(frame, outerScript, innerScripts)
    {
        try
        {
            var context = this.breakContext;
            delete this.breakContext;

            var sourceFile = this.getEvalLevelSourceFile(frame, context, innerScripts);

            dispatch(this.fbListeners,"onEvalScriptCreated",[context, frame, sourceFile.href]);
            return sourceFile;
        }
        catch (e)
        {
        }
    },

    onEventScriptCreated: function(frame, outerScript, innerScripts)
    {
        var context = this.breakContext;
        delete this.breakContext;

        var script = frame.script;
        var creatorURL = normalizeURL(frame.script.fileName);
        var innerScriptArray = [];
        try {
            var source = script.functionSource;

            while (innerScripts.hasMoreElements())
            {
                var inner = innerScripts.getNext();
                source += "\n"+inner.functionSource;
                innerScriptArray.push(inner);
            }

        } catch (exc) {
            /*Bug 426692 */
            var source = creatorURL + "/"+getUniqueId();
        }

        var urlDescribed = this.getDynamicURL(context, normalizeURL(frame.script.fileName), source, "event");
        var url = urlDescribed.href;

        var lines = context.sourceCache.store(url, source);
        var sourceFile = new FBL.EventSourceFile(url, frame.script, "event:"+script.functionName+"."+script.tag, lines, new ArrayEnumerator(innerScriptArray));
        context.addSourceFile(sourceFile);

        dispatch(this.fbListeners,"onEventScriptCreated",[context, frame, url]);
        return sourceFile;
    },

    // We just compiled a bunch of JS, eg a script tag in HTML.  We are about to run the outerScript.
    onTopLevelScriptCreated: function(frame, outerScript, innerScripts)
    {
        var context = this.breakContext;
        delete this.breakContext;

        // This is our only chance to get the linetable for the outerScript since it will run and be GC next.
        var script = frame.script;
        var url = normalizeURL(script.fileName);

        var sourceFile = context.sourceFileMap[url];
        if (sourceFile && (sourceFile instanceof FBL.TopLevelSourceFile) )      // TODO test multiple script tags in one html file
        {
            if (!sourceFile.outerScript || !sourceFile.outerScript.isValid)
                sourceFile.outerScript = outerScript;
            FBL.addScriptsToSourceFile(sourceFile, outerScript, innerScripts);
        }
        else
        {
            sourceFile = new FBL.TopLevelSourceFile(url, script, script.lineExtent, innerScripts);
            context.addSourceFile(sourceFile);
        }

        dispatch(this.fbListeners,"onTopLevelScriptCreated",[context, frame, sourceFile.href]);
        return sourceFile;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    onToggleBreakpoint: function(url, lineNo, isSet, props)
    {
        if (props.debugger != this) // then not for us
        {
            return;
        }

        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var context = TabWatcher.contexts[i];
            if (!isSet && context.dynamicURLhasBP && context.sourceFileMap.hasOwnProperty(url))
                this.checkDynamicURLhasBP(context);

            var panel = context.getPanel("script", true);
            if (panel)
            {
                panel.context.invalidatePanels("breakpoints");

                var sourceBox = panel.getSourceBoxByURL(url);
                if (sourceBox)
                {
                    var row = sourceBox.getLineNode(lineNo);
                    if (!row)
                        continue;  // we *should* only be called for lines in the viewport...

                    row.setAttribute("breakpoint", isSet);
                    if (isSet && props)
                    {
                        row.setAttribute("condition", props.condition ? "true" : "false");
                        if (props.condition)  // issue 1371
                        {
                            var watchPanel = this.ableWatchSidePanel(context);
                            watchPanel.addWatch(props.condition);
                        }
                        row.setAttribute("disabledBreakpoint", new Boolean(props.disabled).toString());
                    }
                    else
                    {
                        row.removeAttribute("condition");
                        if (props.condition)
                        {
                            var watchPanel = this.ableWatchSidePanel(context);
                            watchPanel.removeWatch(props.condition);
                            watchPanel.rebuild();
                        }
                        row.removeAttribute("disabledBreakpoint");
                    }
                }
                else
                {
                }
            }
        }
    },

    onToggleErrorBreakpoint: function(url, lineNo, isSet)
    {
        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var panel = TabWatcher.contexts[i].getPanel("console", true);
            if (panel)
            {
                panel.context.invalidatePanels("breakpoints");

                for (var row = panel.panelNode.firstChild; row; row = row.nextSibling)
                {
                    var error = row.firstChild.repObject;
                    if (error instanceof ErrorMessage && error.href == url && error.lineNo == lineNo)
                    {
                        if (isSet)
                            setClass(row.firstChild, "breakForError");
                        else
                            removeClass(row.firstChild, "breakForError");
                    }
                }
            }
        }
    },

    onToggleMonitor: function(url, lineNo, isSet)
    {
        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var panel = TabWatcher.contexts[i].getPanel("console", true);
            if (panel)
                panel.context.invalidatePanels("breakpoints");
        }
    },

    checkDynamicURLhasBP: function (context)
    {
        context.dynamicURLhasBP = false;
        for (var url in context.sourceFileMap)
        {
             var sourceFile = context.sourceFileMap[url];
               if (sourceFile.isEval() || sourceFile.isEvent())
               {
                   fbs.enumerateBreakpoints(url, {call: function setDynamicIfSet(url, lineNo)
                   {
                       context.dynamicURLhasBP = true;
                   }});
               }
               if (context.dynamicURLhasBP)
                   break;
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // XXXjjb this code is not called, because I found the scheme for detecting Function too complex.
    // I'm leaving it here to remind us that we need to support new Function().
    onFunctionConstructor: function(frame, ctor_script)
    {
       try
        {
            var context = this.breakContext;
            delete this.breakContext;

            var sourceFile = this.createSourceFileForFunctionConstructor(frame, ctor_script, context);

            dispatch(this.fbListeners,"onFunctionConstructor",[context, frame, ctor_script, sourceFile.href]);
            return sourceFile.href;
        }
        catch(exc)
        {
            ERROR("debugger.onFunctionConstructor failed: "+exc);
            return null;
        }

    },

    createSourceFileForFunctionConstructor: function(caller_frame, ctor_script, context)
    {
        var ctor_expr = null; // this.getConstructorExpression(caller_frame, context);
        if (ctor_expr)
            var source  = this.getEvalBody(caller_frame, "lib.createSourceFileForFunctionConstructor ctor_expr", 1, ctor_expr);
        else
            var source = " bah createSourceFileForFunctionConstructor"; //ctor_script.functionSource;

        var url = this.getDynamicURL(context, normalizeURL(caller_frame.script.fileName), source, "Function");

        var lines = context.sourceCache.store(url.href, source);
        var sourceFile = new FBL.FunctionConstructorSourceFile(url, caller_frame.script, ctor_expr, lines.length);
        context.addSourceFile(sourceFile);

        return sourceFile;
    },

    getConstructorExpression: function(caller_frame, context)
    {
        // We believe we are just after the ctor call.
        var decompiled_lineno = getLineAtPC(caller_frame, context);
        var decompiled_lines = splitLines(caller_frame.script.functionSource);  // TODO place in sourceCache?
        var candidate_line = decompiled_lines[decompiled_lineno - 1]; // zero origin
        if (candidate_line && candidate_line != null)
            {
                var m = reFunction.exec(candidate_line);
                if (m)
                    var arguments =  m[1];     // TODO Lame: need to count parens, with escapes and quotes
            }
        if (arguments) // need to break down commas and get last arg.
        {
                var lastComma = arguments.lastIndexOf(',');
                return arguments.substring(lastComma+1);  // if -1 then 0
        }
        return null;
    },
    // end of guilt trip
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

// Called by debugger.onEval() to store eval() source.
// The frame has the blank-function-name script and it is not the top frame.
// The frame.script.fileName is given by spidermonkey as file of the first eval().
// The frame.script.baseLineNumber is given by spidermonkey as the line of the first eval() call
// The source that contains the eval() call is the source of our caller.
// If our caller is a file, the source of our caller is at frame.script.baseLineNumber
// If our caller is an eval, the source of our caller is TODO Check Test Case

    getEvalLevelSourceFile: function(frame, context, innerScripts)
    {
        var eval_expr = this.getEvalExpression(frame, context);
        if (eval_expr && !Firebug.decompileEvals)
        {
            var source  = this.getEvalBody(frame, "lib.getEvalLevelSourceFile.getEvalBody", 1, eval_expr);
            var mapType = PCMAP_SOURCETEXT;
        }
        else
        {
            var source = frame.script.functionSource; // XXXms - possible crash on OSX FF2
            var mapType = PCMAP_PRETTYPRINT;
        }

        var lines = splitLines(source);

        var url = this.getDynamicURL(context, normalizeURL(frame.script.fileName), lines, "eval");

        context.sourceCache.invalidate(url.href);
        context.sourceCache.storeSplitLines(url.href, lines);

        var sourceFile = new FBL.EvalLevelSourceFile(url, frame.script, eval_expr, lines, mapType, innerScripts);
        context.addSourceFile(sourceFile);

        return sourceFile;
    },

    getDynamicURL: function(context, callerURL, lines, kind)
    {
        if (kind == "eval")
        {
            var url = this.getURLFromSpy(context);
            if (url)
                return url;
        }

        var url = this.getURLFromLastLine(context, lines);
        if (url)
            return url;

        var url = this.getSequentialURL(context, callerURL, kind);
        if (url)
            return url;

           var url = this.getURLFromMD5(callerURL, lines, kind);
        if (url)
            return url;

        var url = this.getDataURLForScript(callerURL, lines);
        if (url)
            return url;

        return url;
    },

    getURLFromSpy: function(context)
    {
        var url = null;
        if (context.onReadySpy)  // coool we can get the request URL.
        {
            var href = new String(context.onReadySpy.getURL());
            if (context.sourceFileName && context.sourceFileName[href]) // oops taken
                return null;
            else
            {
                url = {href: href, kind: "data"};
            }
        }

        return url;
    },

    getURLFromLastLine: function(context, lines)
    {
        var url = null;
        // Ignores any trailing whitespace in |source|
        const reURIinComment = /\/\/@\ssourceURL=\s*(\S*?)\s*$/m;
        var m = reURIinComment.exec(lines[lines.length - 1]);
        if (m)
        {
            // add context info to the sourceURL so eval'd sources are grouped correctly in the source file list
            if (m[1] && m[1].indexOf('://') == -1) {
                var loc = context.window.location;
                if (m[1].charAt(0) != '/') m[1] = '/'+m[1]; // prepend leading slash if necessary
                m[1] = loc.protocol + '//' + loc.host + m[1]; // prepend protocol and host
            }

            var href = new String(m[1]);

            url = {href: href, kind: "source"};
        }
        else
        {
        }
        return url;
    },

    getSequentialURL: function(context, callerURL, kind)
    {
        var url = null;
        if (!context.dynamicURLhasBP)
        {
            // If no breakpoints live in dynamic code then we don't need to compare
            // the previous and reloaded source. In that case let's use a cheap URL.
            var href = new String(callerURL + (kind ? "/"+kind+"/" : "/nokind/")+"seq/" +(context.dynamicURLIndex++));
            url = {href: href, kind: "seq"};
        }
        return url;
    },

    getURLFromMD5: function(callerURL, lines, kind)
    {
        this.hash_service.init(this.nsICryptoHash.MD5);
        var source = lines.join('\n'); // we could double loop, would that be any faster?
        byteArray = [];
        for (var j = 0; j < source.length; j++)
        {
            byteArray.push( source.charCodeAt(j) );
        }
        this.hash_service.update(byteArray, byteArray.length);
        var hash = this.hash_service.finish(true);

        // encoding the hash should be ok, it should be information-preserving? Or at least reversable?
        var href= new String(callerURL + (kind ? "/"+kind+"/" : "/nokind/")+"MD5/" + encodeURIComponent(hash));
        url = {href: href, kind: "MD5"};
        return url;
    },

    getDataURLForScript: function(callerURL, lines)
    {
        var url = null;
        var href = null;
        if (!source)
            href = "eval."+script.tag;
        else
        {
            // data:text/javascript;fileName=x%2Cy.js;baseLineNumber=10,<the-url-encoded-data>
            href = new String("data:text/javascript;");
            href += "fileName="+encodeURIComponent(callerURL);
            var source = lines.join('\n');
            //url +=  ";"+ "baseLineNumber="+encodeURIComponent(script.baseLineNumber) +
            href +="," + encodeURIComponent(source);
        }
        url = {href:href, kind:"data"};
        return url;
    },

    // ********************************************************************************
    getEvalExpression: function(frame, context)
    {
        var expr = this.getEvalExpressionFromEval(frame, context);  // eval in eval

        return (expr) ? expr : this.getEvalExpressionFromFile(normalizeURL(frame.script.fileName), frame.script.baseLineNumber, context);
    },

    getEvalExpressionFromFile: function(url, lineNo, context)
    {
        if (context && context.sourceCache)
        {
            var in_url = FBL.reJavascript.exec(url);
            if (in_url)
            {
                var m = reEval.exec(in_url[1]);
                if (m)
                    return m[1];
                else
                    return null;
            }

            var htm = reHTM.exec(url);
            if (htm) {
                lineNo = lineNo + 1; // embedded scripts seem to be off by one?  XXXjjb heuristic
            }
            // Walk backwards from the first line in the function until we find the line which
            // matches the pattern above, which is the eval call
            var line = "";
            for (var i = 0; i < 3; ++i)
            {
                line = context.sourceCache.getLine(url, lineNo-i) + line;
                if (line && line != null)
                {
                    var m = reEval.exec(line);
                    if (m)
                        return m[1];
                }
            }
        }
        return null;
    },

    getEvalExpressionFromEval: function(frame, context)
    {
        var callingFrame = frame.callingFrame;
        var sourceFile = FBL.getSourceFileByScript(context, callingFrame.script);
        if (sourceFile)
        {
            var lineNo = callingFrame.script.pcToLine(callingFrame.pc, PCMAP_SOURCETEXT);
            lineNo = lineNo - callingFrame.script.baseLineNumber + 1;
            var url  = sourceFile.href;

            var line = "";
            for (var i = 0; i < 3; ++i)
            {
                line = context.sourceCache.getLine(url, lineNo-i) + line;
                if (line && line != null)
                {
                    var m = reEval.exec(line);
                    if (m)
                        return m[1];     // TODO Lame: need to count parens, with escapes and quotes
                }
            }
        }
        return null;
    },

    getEvalBody: function(frame, asName, asLine, evalExpr)
    {
        if (evalExpr  && !Firebug.decompileEvals)
        {
            var result_src = {};
            var evalThis = "new String("+evalExpr+");";
            var evaled = frame.eval(evalThis, asName, asLine, result_src);

            if (evaled)
            {
                var src = result_src.value.getWrappedValue();
                return src;
            }
            else
            {
                var source;
                if(evalExpr == "function(p,a,c,k,e,r")
                    source = "/packer/ JS compressor detected";
                else
                    source = frame.script.functionSource;
                return source+" /* !eval("+evalThis+")) */";
            }
        }
        else
        {
            return frame.script.functionSource; // XXXms - possible crash on OSX FF2
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Module

    initialize: function()
    {
        this.nsICryptoHash = Components.interfaces["nsICryptoHash"];

        this.debuggerName =  window.location.href+"--"+FBL.getUniqueId(); /*@explore*/
        this.toString = function() { return this.debuggerName; } /*@explore*/
        this.hash_service = CCSV("@mozilla.org/security/hash;1", "nsICryptoHash");

        $("cmd_breakOnErrors").setAttribute("checked", Firebug.breakOnErrors);
        $("cmd_decompileEvals").setAttribute("checked", Firebug.decompileEvals);

        this.wrappedJSObject = this;  // how we communicate with fbs
        this.panelName = "script";

        // This is a service operation, a way of encapsulating fbs which is in turn implementing this
        // simple service. We could implment a whole component for this service, but it hardly makes sense.
        Firebug.broadcast = function encapsulateFBSBroadcast(message, args)
        {
            fbs.broadcast(message, args);
        }

        this.onFunctionCall = bind(this.onFunctionCall, this);
        Firebug.ActivableModule.initialize.apply(this, arguments);
    },

    enable: function()
    {
        fbs.registerClient(this);   // allow callbacks for jsd
        if (this.isAlwaysEnabled())
            this.registerDebugger();
    },

    initializeUI: function()
    {
        Firebug.ActivableModule.initializeUI.apply(this, arguments);
        this.filterButton = $("fbScriptFilterMenu");
        this.filterMenuUpdate();
    },

    initContext: function(context, persistedState)
    {
        if (persistedState)
            context.dynamicURLhasBP = persistedState.dynamicURLhasBP;

        context.dynamicURLIndex = 1; // any dynamic urls need to be unique to the context.

        Firebug.ActivableModule.initContext.apply(this, arguments);
    },

    reattachContext: function(browser, context)
    {
        this.filterButton = Firebug.chrome.$("fbScriptFilterMenu");  // connect to the button in the new window, not 'window'
        this.filterMenuUpdate();
        Firebug.ActivableModule.reattachContext.apply(this, arguments);
    },

    loadedContext: function(context)
    {
        var watchPanel = this.ableWatchSidePanel(context);
        var needNow = watchPanel && watchPanel.watches;
        var watchPanelState = Firebug.getPanelState({name: "watches", context: context});
        var needPersistent = watchPanelState && watchPanelState.watches;
        if (needNow || needPersistent)
        {
            Firebug.CommandLine.isReadyElsePreparing(context);
            if (watchPanel)
            {
                context.setTimeout(function refreshWatchesAfterCommandLineReady()
                {
                    watchPanel.refresh();
                });
            }
        }

    },

    unwatchWindow: function(context, win)  // clean up the source file map in case the frame is being reloaded.
    {
        var scriptTags = win.document.getElementsByTagName("script");
        for (var i = 0; i < scriptTags.length; i++)
        {
            var src = scriptTags[i].getAttribute("src");
            if (src)
                delete context.sourceFileMap[src];
            else
                delete context.sourceFileMap[safeGetWindowLocation(win)];
        }
        if (scriptTags.length > 0)
            context.invalidatePanels('script');
    },

    destroyContext: function(context, persistedState)
    {
        Firebug.ActivableModule.destroyContext.apply(this, arguments);

        if (context.stopped)
        {
            TabWatcher.cancelNextLoad = true;
            this.abort(context);
        }

        if(persistedState)
        {
            if (context.dynamicURLhasBP)
                persistedState.dynamicURLhasBP = context.dynamicURLhasBP;
            else
                delete persistedState.dynamicURLhasBP;
        }
    },

    updateOption: function(name, value)
    {
        if (name == "breakOnErrors")
            $("cmd_breakOnErrors").setAttribute("checked", value);
        else if (name == "decompileEvals")
            $("cmd_decompileEvals").setAttribute("checked", value);
    },

    getObjectByURL: function(context, url)
    {
        var sourceFile = getSourceFileByHref(url, context);
        if (sourceFile)
            return new SourceLink(sourceFile.href, 0, "js");
    },

    shutdown: function()
    {
        fbs.unregisterDebugger(this);
        fbs.unregisterClient(this);
    },

    registerDebugger: function() // 1.3.1 safe for multiple calls
    {
        if (this.registered)
            return;
        var check = fbs.registerDebugger(this);  //  this will eventually set 'jsd' on the statusIcon
        this.registered = true;
    },

    unregisterDebugger: function() // 1.3.1 safe for multiple calls
    {
        if (!this.registered)
            return;

        var check = fbs.unregisterDebugger(this);

        this.registered = false;

    },

    onSourceFileCreated: function(context, sourceFile)
    {
        // This event can come at any time, eg by frame reloads or ajax, so we need to update the display.
        context.invalidatePanels("script", "breakpoints");
    },
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends ActivableModule

    onPanelEnable: function(panelName)
    {
        if (panelName != this.panelName)
            return;

        this.registerDebugger();

        if (FirebugContext && !fbs.isJSDActive())
            fbs.unPause();

    },

    onPanelDisable: function(panelName)
    {
        if (panelName != this.panelName)
            return;

        if (this.dependents.length > 0)
        {
            for(var i = 0; i < this.dependents.length; i++)
            {
                if (this.dependents[i].isAlwaysEnabled())
                {
                    var name = this.dependents[0].dispatchName; // TODO getName() for modules required.
                    if (FirebugContext)
                        Firebug.Console.log("Cannot disable the script panel, "+name+" panel requires it", FirebugContext);
                    return;
                }
            }
        }
        // else no dependents enabled:
        this.unregisterDebugger();

        this.clearAllBreakpoints();
    },

    onDependentModuleChange: function(dependentAddedOrRemoved)
    {
        if (this.dependents.length > 0) // then we have dependents now
        {
            if (!this.isAlwaysEnabled()) // then we need to enable
            {
                this.setDefaultState(true);
                if (FirebugContext)
                    Firebug.Console.log("enabling javascript debugger to support "+dependentAddedOrRemoved.dispatchName, FirebugContext);
            }
        }
    },

    onSuspendFirebug: function()
    {
        if (!Firebug.Debugger.isAlwaysEnabled())
            return;

        var paused = fbs.pause();  // can be called multiple times.

    },

    onResumeFirebug: function()
    {
        if (!Firebug.Debugger.isAlwaysEnabled())
            return;

        var unpaused = fbs.unPause();

    },

    ableWatchSidePanel: function(context)
    {
        if (Firebug.Console.isAlwaysEnabled())
        {
            var watchPanel = context.getPanel("watches", true);
            if (watchPanel)
                return watchPanel;
        }
        else
            return false;
    },

    //---------------------------------------------------------------------------------------------
    // Menu in toolbar.

    onScriptFilterMenuTooltipShowing: function(tooltip, context)
    {
    },

    onScriptFilterMenuCommand: function(event, context)
    {
        var menu = event.target;
        Firebug.setPref(Firebug.servicePrefDomain, "scriptsFilter", menu.value);
        Firebug.Debugger.filterMenuUpdate();
    },

    menuFullLabel:
    {
        static: $STR("ScriptsFilterStatic"),
        evals: $STR("ScriptsFilterEval"),
        events: $STR("ScriptsFilterEvent"),
        all: $STR("ScriptsFilterAll"),
    },

    menuShortLabel:
    {
        static: $STR("ScriptsFilterStaticShort"),
        evals: $STR("ScriptsFilterEvalShort"),
        events: $STR("ScriptsFilterEventShort"),
        all: $STR("ScriptsFilterAllShort"),
    },

    onScriptFilterMenuPopupShowing: function(menu, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = false;

        var items = menu.getElementsByTagName("menuitem");
        var value = this.filterButton.value;

        for (var i=0; i<items.length; i++)
        {
            var option = items[i].value;
            if (!option)
                continue;

            if (option == value)
                items[i].setAttribute("checked", "true");

            items[i].label = Firebug.Debugger.menuFullLabel[option];
        }

        return true;
    },

    onScriptFilterMenuPopupHiding: function(tooltip, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = true;

        return true;
    },

    filterMenuUpdate: function()
    {
        var value = Firebug.getPref(Firebug.servicePrefDomain, "scriptsFilter");
        this.filterButton.value = value;
        this.filterButton.label = this.menuShortLabel[value];
        this.filterButton.removeAttribute("disabled");
        this.filterButton.setAttribute("value", value);
    },

    //----------------------------------------------------------------------------------

});


// ************************************************************************************************

Firebug.ScriptPanel = function() {};

Firebug.ScriptPanel.prototype = extend(Firebug.SourceBoxPanel,
{

    updateSourceBox: function(sourceBox)
    {
        if (this.scrollInfo && (this.scrollInfo.location == this.location))
            sourceBox.scrollTop = this.scrollInfo.lastScrollTop;
        delete this.scrollInfo;
    },

    getSourceType: function()
    {
        return "js";
    },

    getDecorator: function(sourceBox)
    {
        if (!this.decorator)
            this.decorator = bind(this.decorateJavascript, this, sourceBox);
        return this.decorator;
    },

    decorateJavascript: function(sourceBox)
    {
        this.markExecutableLines(sourceBox);
        this.setLineBreakpoints(sourceBox.repObject, sourceBox)
    },

    showFunction: function(fn)
    {
        var sourceLink = findSourceForFunction(fn, this.context);
        if (sourceLink)
        {
            this.showSourceLink(sourceLink);
        }
        else
        {
        }
    },

    showSourceLink: function(sourceLink)
    {
        var sourceFile = getSourceFileByHref(sourceLink.href, this.context);
        if (sourceFile)
        {
            this.navigate(sourceFile);
            if (sourceLink.line)
            {
                this.scrollToLine(sourceLink.href, sourceLink.line, this.jumpHighlightFactory(sourceLink.line, this.context));
                dispatch([Firebug.A11yModel], "onShowSourceLink", [this, sourceLink.line]);
            }
            if (sourceLink == this.selection)  // then clear it so the next link will scroll and highlight.
                delete this.selection;
        }
    },

    showStackFrame: function(frame)
    {
        if (!frame || (frame && !frame.isValid))
        {
            this.showNoStackFrame();
            return;
        }

        this.context.currentFrame = frame;
        var sourceFile = FBL.getSourceFileByScript(this.context, this.context.currentFrame.script);
        if (!sourceFile)
        {
            this.showNoStackFrame()
            return;
        }

        this.context.executingSourceFile = sourceFile;
        this.executionFile = sourceFile;
        if (this.executionFile)
        {
            var url = this.executionFile.href;
            var analyzer = this.executionFile.getScriptAnalyzer(frame.script);
            this.executionLineNo = analyzer.getSourceLineFromFrame(this.context, frame);  // TODo implement for each type

            this.navigate(this.executionFile);
            this.scrollToLine(url, this.executionLineNo, bind(this.highlightExecutionLine, this) );
            this.context.throttle(this.updateInfoTip, this);
            return;
        }
        else
        {
            this.showNoStackFrame();
        }
    },

    showNoStackFrame: function()
    {
        this.executionFile = null;
        this.executionLineNo = -1;

        if (this.selectedSourceBox)
            this.highlightExecutionLine(this.selectedSourceBox);  // clear highlight

        var panelStatus = Firebug.chrome.getPanelStatusElements();
        panelStatus.clear(); // clear stack on status bar
        this.updateInfoTip();
    },

    markExecutableLines: function(sourceBox)
    {
        var sourceFile = sourceBox.repObject;
        var lineNo = sourceBox.firstViewableLine;
        while( lineNode = sourceBox.getLineNode(lineNo) )
        {
            var script = sourceFile.scriptsIfLineCouldBeExecutable(lineNo, true);

            if (script)
                lineNode.setAttribute("executable", "true");
            else
                lineNode.removeAttribute("executable");

            lineNo++;
        }
    },

    highlightExecutionLine: function(sourceBox)
    {
        if (this.executionLine)  // could point to any node in any sourcebox
            this.executionLine.removeAttribute("exeLine");

        var lineNode = sourceBox.getLineNode(this.executionLineNo);

        this.executionLine = lineNode;  // if null, clears

        if (lineNode)
        {
            lineNode.setAttribute("exeLine", "true");
            if (this.context.breakingError)
            {
                var error = this.context.breakingError;
                if (error.message)
                {
                    sourceBox.breakingError = this.document.createElement("span");
                    sourceBox.breakingError.setAttribute("class", "breakingError");
                    sourceBox.breakingError.innerHTML = cropString(error.message, 40);
                    lineNode.insertBefore(sourceBox.breakingError, lineNode.firstChild);
                }
            }
        }
        else
        {
            if (sourceBox.breakingError)
            {
                sourceBox.breakingError.parentNode.removeChild(sourceBox.breakingError);
                delete sourceBox.breakingError;
            }
        }
        return true; // sticky
    },

    toggleBreakpoint: function(lineNo)
    {
        var lineNode = this.selectedSourceBox.getLineNode(lineNo);
        if (lineNode.getAttribute("breakpoint") == "true")
            fbs.clearBreakpoint(this.location.href, lineNo);
        else
            fbs.setBreakpoint(this.location, lineNo, null, Firebug.Debugger);
    },

    toggleDisableBreakpoint: function(lineNo)
    {
        var lineNode = this.selectedSourceBox.getLineNode(lineNo);
        if (lineNode.getAttribute("disabledBreakpoint") == "true")
            fbs.enableBreakpoint(this.location.href, lineNo);
        else
            fbs.disableBreakpoint(this.location.href, lineNo);
    },

    editBreakpointCondition: function(lineNo)
    {
        var sourceRow = this.selectedSourceBox.getLineNode(lineNo);
        var sourceLine = getChildByClass(sourceRow, "sourceLine");
        var condition = fbs.getBreakpointCondition(this.location.href, lineNo);

        Firebug.Editor.startEditing(sourceLine, condition);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    addSelectionWatch: function()
    {
        var watchPanel = this.context.getPanel("watches", true);
        if (watchPanel)
        {
            var selection = this.document.defaultView.getSelection();
            var source = this.getSourceLinesFrom(selection);
            watchPanel.addWatch(source);
        }
    },

    copySource: function()
    {
        var selection = this.document.defaultView.getSelection();
        var source = this.getSourceLinesFrom(selection);
        copyToClipboard(source);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    updateInfoTip: function()
    {
        var infoTip = this.panelBrowser.infoTip;
        if (infoTip && this.infoTipExpr)
            this.populateInfoTip(infoTip, this.infoTipExpr);
    },

    populateInfoTip: function(infoTip, expr)
    {
        if (!expr || isJavaScriptKeyword(expr))
            return false;

        var self = this;
        // If the evaluate fails, then we report an error and don't show the infoTip
        Firebug.CommandLine.evaluate(expr, this.context, null, this.context.getGlobalScope(),
            function success(result, context)
            {
                var rep = Firebug.getRep(result);
                var tag = rep.shortTag ? rep.shortTag : rep.tag;

                tag.replace({object: result}, infoTip);

                Firebug.chrome.contextMenuObject = result;  // for context menu select()

                self.infoTipExpr = expr;
            },
            function failed(result, context)
            {
                self.infoTipExpr = "";
            }
        );
        return (self.infoTipExpr == expr);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // UI event listeners

    onMouseDown: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (!sourceLine)
            return;

        var sourceRow = sourceLine.parentNode;
        var sourceFile = sourceRow.parentNode.repObject;
        var lineNo = parseInt(sourceLine.textContent);

        if (isLeftClick(event))
            this.toggleBreakpoint(lineNo);
        else if (isShiftClick(event))
            this.toggleDisableBreakpoint(lineNo);
        else if (isControlClick(event) || isMiddleClick(event))
        {
            Firebug.Debugger.runUntil(this.context, sourceFile, lineNo, Firebug.Debugger);
            cancelEvent(event);
        }
    },

    onContextMenu: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (!sourceLine)
            return;

        var lineNo = parseInt(sourceLine.textContent);
        this.editBreakpointCondition(lineNo);
        cancelEvent(event);
    },

    onMouseOver: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (sourceLine)
        {
            if (this.hoveredLine)
                removeClass(this.hoveredLine.parentNode, "hovered");

            this.hoveredLine = sourceLine;

            if (sourceLine)
                setClass(sourceLine.parentNode, "hovered");
        }
    },

    onMouseOut: function(event)
    {
        var sourceLine = getAncestorByClass(event.relatedTarget, "sourceLine");
        if (!sourceLine)
        {
            if (this.hoveredLine)
                removeClass(this.hoveredLine.parentNode, "hovered");

            delete this.hoveredLine;
        }
    },

    onScroll: function(event)
    {
        var scrollingElement = event.target;
        this.reView(scrollingElement);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "script",
    searchable: true,

    initialize: function(context, doc)
    {
        this.onMouseDown = bind(this.onMouseDown, this);
        this.onContextMenu = bind(this.onContextMenu, this);
        this.onMouseOver = bind(this.onMouseOver, this);
        this.onMouseOut = bind(this.onMouseOut, this);
        this.onScroll = bind(this.onScroll, this);
        this.setLineBreakpoints = bind(setLineBreakpoints, this);

        this.panelSplitter = $("fbPanelSplitter");
        this.sidePanelDeck = $("fbSidePanelDeck");

        Firebug.SourceBoxPanel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        delete this.selection; // We want the location (sourcefile) to persist, not the selection (eg stackFrame).
        persistObjects(this, state);

        state.location = this.location;

        var sourceBox = this.selectedSourceBox;
        if (sourceBox)
        {
            var lines = this.getViewableLines(sourceBox);
            state.lastLine = lines ? lines.bottom - lines.top : 0;

            delete this.selectedSourceBox;
        }

        Firebug.SourceBoxPanel.destroy.apply(this, arguments);
    },

    detach: function(oldChrome, newChrome)
    {
        if (this.selectedSourceBox)
            this.lastSourceScrollTop = this.selectedSourceBox.scrollTop;

        if (this.context.stopped)
        {
            Firebug.Debugger.detachListeners(this.context, oldChrome);
            Firebug.Debugger.attachListeners(this.context, newChrome);
        }

        Firebug.Debugger.syncCommands(this.context);

        Firebug.SourceBoxPanel.detach.apply(this, arguments);
    },

    reattach: function(doc)
    {
        Firebug.SourceBoxPanel.reattach.apply(this, arguments);

        setTimeout(bind(function delayScrollToLastTop()
        {
            if (this.lastSourceScrollTop)
            {
                this.selectedSourceBox.scrollTop = this.lastSourceScrollTop;
                delete this.lastSourceScrollTop;
            }
        }, this));
    },

    initializeNode: function(oldPanelNode)
    {
        this.tooltip = this.document.createElement("div");
        setClass(this.tooltip, "scriptTooltip");
        this.tooltip.setAttribute('aria-live', 'polite')
        obscure(this.tooltip, true);
        this.panelNode.appendChild(this.tooltip);

        this.panelNode.addEventListener("mousedown", this.onMouseDown, true);
        this.panelNode.addEventListener("contextmenu", this.onContextMenu, false);
        this.panelNode.addEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.addEventListener("mouseout", this.onMouseOut, false);
        this.panelNode.addEventListener("scroll", this.onScroll, true);
        Firebug.SourceBoxPanel.initializeNode.apply(this, arguments);
        dispatch([Firebug.A11yModel], "onInitializeNode", [this]);
    },

    destroyNode: function()
    {
        if (this.tooltipTimeout)
            clearTimeout(this.tooltipTimeout);

        this.panelNode.removeEventListener("mousedown", this.onMouseDown, true);
        this.panelNode.removeEventListener("contextmenu", this.onContextMenu, false);
        this.panelNode.removeEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.removeEventListener("mouseout", this.onMouseOut, false);
        this.panelNode.removeEventListener("scroll", this.onScroll, true);
        Firebug.SourceBoxPanel.destroyNode.apply(this, arguments);
        dispatch([Firebug.A11yModel], "onDestroyNode", [this]);
    },

    clear: function()
    {
        clearNode(this.panelNode);
    },

    show: function(state)
    {
        var enabled = Firebug.Debugger.isAlwaysEnabled();

        // The "enable/disable" button is always visible.
        this.showToolbarButtons("fbScriptButtons", true);

        // These buttons are visible only if debugger is enabled.
        this.showToolbarButtons("fbLocationSeparator", enabled);
        this.showToolbarButtons("fbDebuggerButtons", enabled);
        this.showToolbarButtons("fbLocationList", enabled);
        this.showToolbarButtons("fbScriptButtons", enabled);

        // Additional debugger panels are visible only if debugger
        // is enabled.
        this.panelSplitter.collapsed = !enabled;
        this.sidePanelDeck.collapsed = !enabled;

        if (enabled)
        {
            Firebug.Debugger.disabledPanelPage.hide(this);

            if (!this.context.stopped)
                Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "true"); // allow break on next

            if (this.context.loaded)
            {
                if(!this.location)
                {
                    restoreLocation(this, state);

                    if (state && this.location)  // then we are restoring and we have a location, so scroll when we can
                        this.scrollInfo = { location: this.location, lastLine: state.lastLine};
                }
                else  // we have a location from before
                {
                    if (this.selectedSourceBox)  // so we need only refresh the view
                        this.reView(this.selectedSourceBox);
                    else                         // somehow we did not make a sourcebox?
                        this.navigate(this.location);
                }
            }

            var breakpointPanel = this.context.getPanel("breakpoints", true);
            if (breakpointPanel)
                breakpointPanel.refresh();
        }
        else
        {
            Firebug.Debugger.disabledPanelPage.show(this);
        }
    },

    enablePanel: function(module)
    {
        Firebug.ActivablePanel.enablePanel.apply(this, arguments);

        this.panelSplitter.collapsed = false;
        this.sidePanelDeck.collapsed = false;
    },

    disablePanel: function(module)
    {
        Firebug.ActivablePanel.disablePanel.apply(this, arguments);

        this.panelSplitter.collapsed = true;
        this.sidePanelDeck.collapsed = true;
    },

    hide: function(state)
    {
        if (!this.context.stopped)
        {
            Firebug.chrome.setGlobalAttribute("cmd_resumeExecution", "breakable", "disabled");
            this.showToolbarButtons("fbDebuggerButtons", false);
        } // else leave the buttons so we can see that we are stopped

        this.showToolbarButtons("fbScriptButtons", false);
        var panelStatus = Firebug.chrome.getPanelStatusElements();
        FBL.hide(panelStatus, false);

        delete this.infoTipExpr;
    },

    search: function(text, reverse)
    {
        var sourceBox = this.selectedSourceBox;
        if (!text || !sourceBox)
        {
            delete this.currentSearch;
            return false;
        }

        // Check if the search is for a line number
        var m = reLineNumber.exec(text);
        if (m)
        {
            if (!m[1])
                return true; // Don't beep if only a # has been typed

            var lineNo = parseInt(m[1]);
            if (!isNaN(lineNo) && (lineNo > 0) && (lineNo < sourceBox.lines.length) )
            {
                this.scrollToLine(sourceBox.repObject.href, lineNo,  this.jumpHighlightFactory(lineNo, this.context))
                return true;
            }
        }

        var curDoc = this.searchCurrentDoc(!Firebug.searchGlobal, text, reverse);
        if (!curDoc && Firebug.searchGlobal)
        {
            return this.searchOtherDocs(text, reverse);
        }
        return curDoc;
    },

    searchOtherDocs: function(text, reverse)
    {
        var scanRE = new RegExp(text, Firebug.searchCaseSensitive ? "g" : "gi");

        var self = this;

        function scanDoc(sourceFile) {
            var lines = sourceFile.loadScriptLines(self.context);
            if (!lines)
                return;
            // we don't care about reverse here as we are just looking for existence,
            // if we do have a result we will handle the reverse logic on display
            for (var i = 0; i < lines.length; i++) {
                if (scanRE.test(lines[i]))
                {
                    return true;
                }
            }
        }

        if (this.navigateToNextDocument(scanDoc, reverse))
        {
            return this.searchCurrentDoc(true, text, reverse);
        }
    },

    searchCurrentDoc: function(wrapSearch, text, reverse)
    {
        var sourceBox = this.selectedSourceBox;

        var lineNo = null;
        if (this.currentSearch && text == this.currentSearch.text)
            lineNo = this.currentSearch.findNext(wrapSearch, reverse, !!Firebug.searchCaseSensitive);
        else
        {
            this.currentSearch = new SourceBoxTextSearch(sourceBox);
            lineNo = this.currentSearch.find(text, reverse, !!Firebug.searchCaseSensitive);
        }

        if (lineNo || lineNo === 0)
        {
            // this lineNo is an zero-based index into sourceBox.lines. Add one for user line numbers
            this.scrollToLine(sourceBox.repObject.href, lineNo, this.jumpHighlightFactory(lineNo+1, this.context));
            dispatch([Firebug.A11yModel], 'onScriptSearchMatchFound', [this, text, sourceBox.repObject, lineNo]);

            return true;
        }
        else
        {
            dispatch([Firebug.A11yModel], 'onScriptSearchMatchFound', [this, text, null, null]);
            return false;
        }
    },

    getSearchOptionsMenuItems: function()
    {
        return [
            optionMenu("search.script.Multiple_Files", "searchGlobal")
        ];
    },

    supportsObject: function(object)
    {
        if( object instanceof jsdIStackFrame
            || object instanceof SourceFile
            || (object instanceof SourceLink && object.type == "js")
            || typeof(object) == "function" )
            return 1;
        else return 0;
    },

    hasObject: function(object)
    {
        FBTrace.sysout("debugger.hasObject in "+this.context.getName()+" SourceLink: "+(object instanceof SourceLink), object);
        if (object instanceof SourceFile)
            return (object.href in this.context.sourceFileMap);
        else if (object instanceof SourceLink)
            return (object.href in this.context.sourceFileMap);
        else if (object instanceof jsdIStackFrame)
            return (normalizeURL(object.script.fileName) in this.context.sourceFileMap);
        else if (object instanceof "function")
            return false; //TODO
    },

    refresh: function()  // delete any sourceBox-es that are not in sync with sourceFiles
    {
        for(var url in this.sourceBoxes)
        {
            if (this.sourceBoxes.hasOwnProperty(url))
            {
                var sourceBox = this.sourceBoxes[url];
                var sourceFile = this.context.sourceFileMap[url];
                if (sourceFile != sourceBox.repObject)
                {
                    var victim = this.sourceBoxes[url];
                    delete this.sourceBoxes[url];
                    if (this.selectedSourceBox == victim)
                        this.showSourceFile(sourceFile);
                }
            }
        }

        if (!this.selectedSourceBox)  // then show() has not run, but we have to refresh, so do the default.
            this.navigate();
    },

    updateLocation: function(sourceFile)
    {
        if (!sourceFile)
            return;  // XXXjjb do we need to show a blank?

        // Since our last use of the sourceFile we may have compiled or recompiled the source
        var updatedSourceFile = this.context.sourceFileMap[sourceFile.href];
        if (!updatedSourceFile)
            updatedSourceFile = this.getDefaultLocation(this.context);
        if (!updatedSourceFile)
            return;

        this.showSourceFile(updatedSourceFile);
        dispatch([Firebug.A11yModel], "onUpdateScriptLocation", [this, updatedSourceFile]);
    },

    updateSelection: function(object)
    {
        if (object instanceof jsdIStackFrame)
            this.showStackFrame(object);
        else if (object instanceof SourceFile)
            this.navigate(object);
        else if (object instanceof SourceLink)
            this.showSourceLink(object);
        else if (typeof(object) == "function")
            this.showFunction(object);
        else
            this.showStackFrame(null);
    },

    showThisSourceFile: function(sourceFile)
    {
        //-----------------------------------123456789
        if (sourceFile.href.substr(0, 9) == "chrome://")
            return false;

           if (sourceFile.isEval() && !this.showEvals)
               return false;

        if (sourceFile.isEvent() && !this.showEvents)
            return false;

        return true;
    },

    getLocationList: function()
    {
        var context = this.context;

        if (!context.onLoadWindowContent) // then context was not active during load
            updateScriptFiles(context);

        var allSources = sourceFilesAsArray(context.sourceFileMap);

        if (Firebug.showAllSourceFiles)
        {
            return allSources;
        }

        var filter = Firebug.getPref(Firebug.servicePrefDomain, "scriptsFilter");
        this.showEvents = (filter == "all" || filter == "events");
        this.showEvals = (filter == "all" || filter == "evals");

        var list = [];
        for (var i = 0; i < allSources.length; i++)
        {
            if (this.showThisSourceFile(allSources[i]))
                list.push(allSources[i]);
        }

        return list;
    },

    getDefaultLocation: function(context)
    {
        var sourceFiles = this.getLocationList();
        if (context)
        {
            var url = context.getWindowLocation();
            for (var i = 0; i < sourceFiles.length; i++)
            {
                if (url == sourceFiles[i].href)
                    return sourceFiles[i];
            }
            return sourceFiles[0];
        }
        else
            return sourceFiles[0];
    },

    getDefaultSelection: function(context)
    {
        return this.getDefaultLocation(context);
    },

    getTooltipObject: function(target)
    {
        // Target should be A element with class = sourceLine
        if ( hasClass(target, 'sourceLine') )
        {
            var lineNo = parseInt(target.innerHTML);

            if ( isNaN(lineNo) )
                return;
            var scripts = this.location.scriptsIfLineCouldBeExecutable(lineNo);
            if (scripts)
            {
                var str = "scripts ";
                for(var i = 0; i < scripts.length; i++)
                    str += scripts[i].tag +" ";
                return str;
            }
            else
                return new String("no executable script at "+lineNo);
        }
        return null;
    },

    getPopupObject: function(target)
    {
        // Don't show popup over the line numbers, we show the conditional breakpoint
        // editor there instead
        var sourceLine = getAncestorByClass(target, "sourceLine");
        if (sourceLine)
            return;

        var sourceRow = getAncestorByClass(target, "sourceRow");
        if (!sourceRow)
            return;

        var lineNo = parseInt(sourceRow.firstChild.textContent);
        var scripts = findScripts(this.context, this.location.href, lineNo);
        return scripts; // gee I wonder what will happen?
    },

    showInfoTip: function(infoTip, target, x, y, rangeParent, rangeOffset)
    {
        var frame = this.context.currentFrame;
        if (!frame)
            return;

        var sourceRowText = getAncestorByClass(target, "sourceRowText");
        if (!sourceRowText)
            return;

        // see http://code.google.com/p/fbug/issues/detail?id=889
        // idea from: Jonathan Zarate's rikaichan extension (http://www.polarcloud.com/rikaichan/)
        if (!rangeParent)
            return;
        rangeOffset = rangeOffset || 0;
        var expr = getExpressionAt(rangeParent.data, rangeOffset);
        if (!expr || !expr.expr)
            return;

        if (expr.expr == this.infoTipExpr)
            return true;
        else
            return this.populateInfoTip(infoTip, expr.expr);
    },

    getObjectPath: function(frame)
    {
        frame = this.context.debugFrame;

        var frames = [];
        for (; frame; frame = getCallingFrame(frame))
            frames.push(frame);

        return frames;
    },

    getObjectLocation: function(sourceFile)
    {
        return sourceFile.href;
    },

    // return.path: group/category label, return.name: item label
    getObjectDescription: function(sourceFile)
    {
        return sourceFile.getObjectDescription();
    },

    getOptionsMenuItems: function()
    {
        var context = this.context;

        return [
            serviceOptionMenu("BreakOnAllErrors", "breakOnErrors"),
            optionMenu("DecompileEvals", "decompileEvals"),
            serviceOptionMenu("ShowAllSourceFiles", "showAllSourceFiles"),
            // 1.2: always check last line; optionMenu("UseLastLineForEvalName", "useLastLineForEvalName"),
            // 1.2: always use MD5 optionMenu("UseMD5ForEvalName", "useMD5ForEvalName")
            serviceOptionMenu("TrackThrowCatch", "trackThrowCatch"),
            //"-",
            //1.2 option on toolbar this.optionMenu("DebuggerEnableAlways", enableAlwaysPref)
        ];
    },

    optionMenu: function(label, option)
    {
        var checked = Firebug.getPref(prefDomain, option);
        return {label: label, type: "checkbox", checked: checked,
            command: bindFixed(Firebug.setPref, Firebug, prefDomain, option, !checked) };
    },

    getContextMenuItems: function(fn, target)
    {
        if (getAncestorByClass(target, "sourceLine"))
            return;

        var sourceRow = getAncestorByClass(target, "sourceRow");
        if (!sourceRow)
            return;

        var sourceLine = getChildByClass(sourceRow, "sourceLine");
        var lineNo = parseInt(sourceLine.textContent);

        var items = [];

        var selection = this.document.defaultView.getSelection();
        if (selection.toString())
        {
            items.push(
                {label: "CopySourceCode", command: bind(this.copySource, this) },
                "-",
                {label: "AddWatch", command: bind(this.addSelectionWatch, this) }
            );
        }

        var hasBreakpoint = sourceRow.getAttribute("breakpoint") == "true";

        items.push(
            "-",
            {label: "SetBreakpoint", type: "checkbox", checked: hasBreakpoint,
                command: bindFixed(this.toggleBreakpoint, this, lineNo) }
        );
        if (hasBreakpoint)
        {
            var isDisabled = fbs.isBreakpointDisabled(this.location.href, lineNo);
            items.push(
                {label: "DisableBreakpoint", type: "checkbox", checked: isDisabled,
                    command: bindFixed(this.toggleDisableBreakpoint, this, lineNo) }
            );
        }
        items.push(
            {label: "EditBreakpointCondition",
                command: bindFixed(this.editBreakpointCondition, this, lineNo) }
        );

        if (this.context.stopped)
        {
            var sourceRow = getAncestorByClass(target, "sourceRow");
            if (sourceRow)
            {
                var sourceFile = sourceRow.parentNode.repObject;
                var lineNo = parseInt(sourceRow.firstChild.textContent);

                var debuggr = Firebug.Debugger;
                items.push(
                    "-",
                    {label: "Continue",
                        command: bindFixed(debuggr.resume, debuggr, this.context) },
                    {label: "StepOver",
                        command: bindFixed(debuggr.stepOver, debuggr, this.context) },
                    {label: "StepInto",
                        command: bindFixed(debuggr.stepInto, debuggr, this.context) },
                    {label: "StepOut",
                        command: bindFixed(debuggr.stepOut, debuggr, this.context) },
                    {label: "RunUntil",
                        command: bindFixed(debuggr.runUntil, debuggr, this.context,
                        sourceFile, lineNo) }
                );
            }
        }

        return items;
    },

    getEditor: function(target, value)
    {
        if (!this.conditionEditor)
            this.conditionEditor = new ConditionEditor(this.document);

        return this.conditionEditor;
    },

});

// ************************************************************************************************

var BreakpointsTemplate = domplate(Firebug.Rep,
{
    tag:
        DIV({onclick: "$onClick", role : 'list'},
            FOR("group", "$groups",
                DIV({class: "breakpointBlock breakpointBlock-$group.name", role: 'listitem'},
                    H1({class: "breakpointHeader groupHeader"},
                        "$group.title"
                    ),
                    DIV({class : "breakpointsGroupListBox", role: 'listbox'},
                        FOR("bp", "$group.breakpoints",
                            DIV({class: "breakpointRow focusRow", role : 'option', 'aria-checked' : "$bp.checked"},
                                DIV({class: "breakpointBlockHead"},
                                    INPUT({class: "breakpointCheckbox", type: "checkbox",
                                        _checked: "$bp.checked", tabindex : '-1'}),
                                    SPAN({class: "breakpointName"}, "$bp.name"),
                                    TAG(FirebugReps.SourceLink.tag, {object: "$bp|getSourceLink"}),
                                    IMG({class: "closeButton", src: "blank.gif"})
                                ),
                                DIV({class: "breakpointCode"}, "$bp.sourceLine")
                            )
                        )
                    )
                )
            )
        ),

    getSourceLink: function(bp)
    {
        return new SourceLink(bp.href, bp.lineNumber, "js");
    },

    onClick: function(event)
    {
        var panel = Firebug.getElementPanel(event.target);

        if (getAncestorByClass(event.target, "breakpointCheckbox"))
        {
            var sourceLink =
                getElementByClass(event.target.parentNode, "objectLink-sourceLink").repObject;

            panel.noRefresh = true;
            if (event.target.checked)
                fbs.enableBreakpoint(sourceLink.href, sourceLink.line);
            else
                fbs.disableBreakpoint(sourceLink.href, sourceLink.line);
            panel.noRefresh = false;
        }
        else if (getAncestorByClass(event.target, "closeButton"))
        {
            var sourceLink =
                getElementByClass(event.target.parentNode, "objectLink-sourceLink").repObject;

            panel.noRefresh = true;

            var head = getAncestorByClass(event.target, "breakpointBlock");
            var groupName = getClassValue(head, "breakpointBlock");
            if (groupName == "breakpoints")
                fbs.clearBreakpoint(sourceLink.href, sourceLink.line);
            else if (groupName == "errorBreakpoints")
                fbs.clearErrorBreakpoint(sourceLink.href, sourceLink.line);
            else if (groupName == "monitors")
            {
                fbs.unmonitor(sourceLink.href, sourceLink.line)
            }

            var row = getAncestorByClass(event.target, "breakpointRow");
            panel.removeRow(row);

            panel.noRefresh = false;
        }
    }
});

// ************************************************************************************************

function BreakpointsPanel() {}

BreakpointsPanel.prototype = extend(Firebug.Panel,
{
    removeRow: function(row)
    {
        row.parentNode.removeChild(row);

        var bpCount = countBreakpoints(this.context);
        if (!bpCount)
            this.refresh();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "breakpoints",
    parentPanel: "script",
    order: 2,

    initialize: function()
    {
        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        Firebug.Panel.destroy.apply(this, arguments);
    },

    initializeNode : function(oldPanelNode)
    {
        dispatch([Firebug.A11yModel], 'onInitializeNode', [this, 'console']);
    },

    destroyNode : function()
    {
        dispatch([Firebug.A11yModel], 'onDestroyNode', [this, 'console']);
    },

    show: function(state)
    {
        this.refresh();
    },

    refresh: function()
    {
        if (!Firebug.Debugger.isAlwaysEnabled(this.context))
            updateScriptFiles(this.context);

        var extracted = this.extractBreakpoints(this.context, breakpoints, errorBreakpoints, monitors);

        var breakpoints = extracted.breakpoints;
        var errorBreakpoints = extracted.errorBreakpoints;
        var monitors = extracted.monitors;

        function sortBreakpoints(a, b)
        {
            if (a.href == b.href)
                return a.lineNumber < b.lineNumber ? -1 : 1;
            else
                return a.href < b.href ? -1 : 1;
        }

        breakpoints.sort(sortBreakpoints);
        errorBreakpoints.sort(sortBreakpoints);
        monitors.sort(sortBreakpoints);

        var groups = [];

        if (breakpoints.length)
            groups.push({name: "breakpoints", title: $STR("Breakpoints"),
                breakpoints: breakpoints});
        if (errorBreakpoints.length)
            groups.push({name: "errorBreakpoints", title: $STR("ErrorBreakpoints"),
                breakpoints: errorBreakpoints});
        if (monitors.length)
            groups.push({name: "monitors", title: $STR("LoggedFunctions"),
                breakpoints: monitors});

        if (groups.length)
            BreakpointsTemplate.tag.replace({groups: groups}, this.panelNode);
        else
            FirebugReps.Warning.tag.replace({object: "NoBreakpointsWarning"}, this.panelNode);

        dispatch([Firebug.A11yModel], 'onBreakRowsRefreshed', [this, this.panelNode]);
    },

    extractBreakpoints: function(context, breakpoints, errorBreakpoints, monitors)
    {
        var breakpoints = [];
        var errorBreakpoints = [];
        var monitors = [];

        var renamer = new SourceFileRenamer(context);
        var self = this;

        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, line, props, script)
            {
                if (renamer.checkForRename(url, line, props)) // some url in this sourceFileMap has changed, we'll be back.
                    return;

                if (script)  // then this is a current (not future) breakpoint
                {
                    var analyzer = getScriptAnalyzer(context, script);
                    if (analyzer)
                        var name = analyzer.getFunctionDescription(script, context).name;
                    else
                        var name = FBL.guessFunctionName(url, 1, context);
                    var isFuture = false;
                }
                else
                {
                    var isFuture = true;
                }

                var source = context.sourceCache.getLine(url, line);
                breakpoints.push({name : name, href: url, lineNumber: line,
                    checked: !props.disabled, sourceLine: source, isFuture: isFuture});
            }});

            fbs.enumerateErrorBreakpoints(url, {call: function(url, line, props)
            {
                if (renamer.checkForRename(url, line, props)) // some url in this sourceFileMap has changed, we'll be back.
                    return;

                var name = self.guessEnclosingFunctionName(url, line);
                var source = context.sourceCache.getLine(url, line);
                errorBreakpoints.push({name: name, href: url, lineNumber: line, checked: true,
                    sourceLine: source});
            }});

            fbs.enumerateMonitors(url, {call: function(url, line, props)
            {
                if (renamer.checkForRename(url, line, props)) // some url in this sourceFileMap has changed, we'll be back.
                    return;

                var name = self.guessEnclosingFunctionName(url, line);
                monitors.push({name: name, href: url, lineNumber: line, checked: true,
                        sourceLine: ""});
            }});

        }

        var result = null;

        if (renamer.needToRename(context))
            result = this.extractBreakpoints(context); // since we renamed some sourceFiles we need to refresh the breakpoints again.
        else
            result = { breakpoints: breakpoints, errorBreakpoints: errorBreakpoints, monitors: monitors };

        // even if we did not rename, some bp may be dynamic
        return result;
    },

    getOptionsMenuItems: function()
    {
        var items = [];

        var context = this.context;
        if (!Firebug.Debugger.isAlwaysEnabled(context))
            updateScriptFiles(context);

        var bpCount = 0, disabledCount = 0;
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, line)
            {
                ++bpCount;
                if (fbs.isBreakpointDisabled(url, line))
                    ++disabledCount;
            }});
        }

        if (disabledCount)
        {
            items.push(
                {label: "EnableAllBreakpoints",
                    command: bindFixed(
                        Firebug.Debugger.enableAllBreakpoints, Firebug.Debugger, context) }
            );
        }
        if (bpCount && disabledCount != bpCount)
        {
            items.push(
                {label: "DisableAllBreakpoints",
                    command: bindFixed(
                        Firebug.Debugger.disableAllBreakpoints, Firebug.Debugger, context) }
            );
        }

        items.push(
            "-",
            {label: "ClearAllBreakpoints", disabled: !bpCount,
                command: bindFixed(Firebug.Debugger.clearAllBreakpoints, Firebug.Debugger, context) }
        );

        return items;
    },

});

function SourceFileRenamer(context)
{
    this.renamedSourceFiles = [];
    this.context = context;
    this.bps = [];
}

SourceFileRenamer.prototype.checkForRename = function(url, line, props)
{
    var sourceFile = this.context.sourceFileMap[url];
    if (sourceFile.isEval() || sourceFile.isEvent())
    {
        var segs = sourceFile.href.split('/');
        if (segs.length > 2)
        {
            if (segs[segs.length - 2] == "seq")
            {
                this.renamedSourceFiles.push(sourceFile);
                this.bps.push(props);
            }
        }
        this.context.dynamicURLhasBP = true;  // whether not we needed to rename, the dynamic sourceFile has a bp.
    }
    else
    {
    }

    return (this.renamedSourceFiles.length > 0);
};

SourceFileRenamer.prototype.needToRename = function(context)
{
    if (this.renamedSourceFiles.length > 0)
        this.renameSourceFiles(context);

    return this.renamedSourceFiles.length;
}

SourceFileRenamer.prototype.renameSourceFiles = function(context)
{
    for (var i = 0; i < this.renamedSourceFiles.length; i++)
    {
        var sourceFile = this.renamedSourceFiles[i];
        var bp = this.bps[i];
        FBTrace.sysout("debugger.renameSourceFiles type: "+bp.type, bp);
        var oldURL = sourceFile.href;
        var sameType = bp.type;
        var sameLineNo = bp.lineNo;
        var sameDebuggr = bp.debugger;

        var segs = oldURL.split('/');  // last is sequence #, next-last is "seq", next-next-last is kind
        var kind = segs.splice(segs.length - 3, 3)[0];
        var callerURL = segs.join('/');
        var newURL = Firebug.Debugger.getURLFromMD5(callerURL, sourceFile.source, kind);
        sourceFile.href = newURL.href;

        fbs.removeBreakpoint(bp.type, oldURL, bp.lineNo);
        delete context.sourceFileMap[oldURL];  // SourceFile delete

        context.addSourceFile(sourceFile);
        var newBP = fbs.addBreakpoint(sameType, sourceFile, sameLineNo, bp, sameDebuggr);

        var panel = context.getPanel("script", true);
        if (panel)
        {
            panel.context.invalidatePanels("breakpoints");
            panel.renameSourceBox(oldURL, newURL.href);
        }
        if (context.sourceCache.isCached(oldURL))
        {
            var lines = context.sourceCache.load(oldURL);
            context.sourceCache.storeSplitLines(newURL.href, lines);
            context.sourceCache.invalidate(oldURL);
        }

    }
    return this.renamedSourceFiles.length;
}

// ******************************************************************************

Firebug.DebuggerListener =
{
    onPauseJSDRequested: function(rejection)
    {
        // push true to cause rejection
    },

    onJSDActivate: function(jsd, why)  // start or unPause
    {

    },
    onJSDDeactivate: function(jsd, why) // stop or pause
    {

    },
    onStop: function(context, frame, type, rv)
    {
    },

    onResume: function(context)
    {
    },

    onThrow: function(context, frame, rv)
    {
        return false; /* continue throw */
    },

    onError: function(context, frame, error)
    {
    },

    onEventScriptCreated: function(context, frame, url, sourceFile)
    {
    },

    onTopLevelScriptCreated: function(context, frame, url, sourceFile)
    {
    },

    onEvalScriptCreated: function(context, frame, url, sourceFile)
    {
    },

    onFunctionConstructor: function(context, frame, ctor_script, url, sourceFile)
    {
    },
};

// ************************************************************************************************

function CallstackPanel() { }

CallstackPanel.prototype = extend(Firebug.Panel,
{
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "callstack",
    parentPanel: "script",
    order: 1,

    initialize: function(context, doc)
    {
        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        Firebug.Panel.destroy.apply(this, arguments);
    },

    initializeNode : function(oldPanelNode)
    {
        dispatch([Firebug.A11yModel], 'onInitializeNode', [this, 'console']);
    },

    destroyNode : function()
    {
        dispatch([Firebug.A11yModel], 'onDestroyNode', [this, 'console']);
    },

    show: function(state)
    {
          this.refresh();
    },

    supportsObject: function(object)
    {
        return object instanceof jsdIStackFrame;
    },

    updateSelection: function(object)
    {
        if (object instanceof jsdIStackFrame)
            this.showStackFrame(object);
    },

    refresh: function()
    {
        var mainPanel = this.context.getPanel("script", true);
        if (mainPanel.selection instanceof jsdIStackFrame)
            this.showStackFrame(mainPanel.selection);
    },

    showStackFrame: function(frame)
    {
        clearNode(this.panelNode);
        var mainPanel = this.context.getPanel("script", true);

        if (mainPanel && frame)
        {
            FBL.setClass(this.panelNode, "objectBox-stackTrace");
            // The panelStatus has the stack, lets reuse it to give the same UX as that control.
            // TODO use domplate? Use the panel status directly?
            var panelStatus = Firebug.chrome.getPanelStatusElements();
            var frameButtons = panelStatus.getElementsByTagName("toolbarbutton");
            var doc = this.panelNode.ownerDocument;
            for (var i = 0; i < frameButtons.length; i++)
            {
                if (FBL.hasClass(frameButtons[i], "panelStatusLabel"))
                {
                    var div = doc.createElement("div");
                    var frameButton = frameButtons[i];
                    div.innerHTML = frameButton.getAttribute('label');
                    if (frameButton.repObject instanceof jsdIStackFrame)  // causes a downcast
                        div.repObject = frameButton.repObject;
                    div.frameButton = frameButton;
                    FBL.setClass(div, "objectLink");
                    FBL.setClass(div, "objectLink-stackFrame");
                    FBL.setClass(div, "panelStatusLabel");
                    FBL.setClass(div, "focusRow");
                    div.setAttribute('role', "listitem");

                    this.panelNode.appendChild(div);
                }
            }
            dispatch([Firebug.A11yModel], 'onstackCreated', [this]);
        }
    },

    highlightFrame: function(frame)
    {
        var frameViews = this.panelNode.childNodes
        for (var child = this.panelNode.firstChild; child; child = child.nextSibling)
        {
            if (child.label && child.label.repObject && child.label.repObject == frame)
            {
                this.selectItem(child);
                return true;
            }
        }
        return false;
    },

    selectItem: function(item)
    {
        if (this.selectedItem)
            this.selectedItem.removeAttribute("selected");

        this.selectedItem = item;

        if (item)
            item.setAttribute("selected", "true");
    },

    getOptionsMenuItems: function()
    {
        var items = [
            optionMenu("OmitObjectPathStack", "omitObjectPathStack"),  // an option handled by chrome.js
            ];
        return items;
    }
});

// ************************************************************************************************
// Local Helpers

function ConditionEditor(doc)
{
    this.box = this.tag.replace({}, doc, this);
    this.input = this.box.childNodes[1].firstChild.firstChild.lastChild;  // XXXjjb we need childNode[1] always
    this.initialize();
}

ConditionEditor.prototype = domplate(Firebug.InlineEditor.prototype,
{
    tag:
        DIV({class: "conditionEditor"},
            DIV({class: "conditionEditorTop1"},
                DIV({class: "conditionEditorTop2"})
            ),
            DIV({class: "conditionEditorInner1"},
                DIV({class: "conditionEditorInner2"},
                    DIV({class: "conditionEditorInner"},
                        DIV({class: "conditionCaption"}, $STR("ConditionInput")),
                        INPUT({class: "conditionInput", type: "text", 'aria-label' : $STR("ConditionInput")})
                    )
                )
            ),
            DIV({class: "conditionEditorBottom1"},
                DIV({class: "conditionEditorBottom2"})
            )
        ),

    show: function(sourceLine, panel, value)
    {
        this.target = sourceLine;
        this.panel = panel;

        this.getAutoCompleter().reset();

        hide(this.box, true);
        panel.selectedSourceBox.appendChild(this.box);

        this.input.value = value;

        setTimeout(bindFixed(function()
        {
            var offset = getClientOffset(sourceLine);

            var bottom = offset.y+sourceLine.offsetHeight;
            var y = bottom - this.box.offsetHeight;
            if (y < panel.selectedSourceBox.scrollTop)
            {
                y = offset.y;
                setClass(this.box, "upsideDown");
            }
            else
                removeClass(this.box, "upsideDown");

            this.box.style.top = y + "px";
            hide(this.box, false);

            this.input.focus();
            this.input.select();
        }, this));
    },

    hide: function()
    {
        this.box.parentNode.removeChild(this.box);

        delete this.target;
        delete this.panel;
    },

    layout: function()
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    endEditing: function(target, value, cancel)
    {
        if (!cancel)
        {
            var sourceFile = this.panel.location;
            var lineNo = parseInt(this.target.textContent);

            fbs.setBreakpointCondition(sourceFile, lineNo, value, Firebug.Debugger);
        }
    }
});

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

function setLineBreakpoints(sourceFile, sourceBox)
{
    fbs.enumerateBreakpoints(sourceFile.href, {call: function(url, line, props, script)
    {
        var scriptRow = sourceBox.getLineNode(line);
        if (scriptRow)
        {
            scriptRow.setAttribute("breakpoint", "true");
            if (props.disabled)
                scriptRow.setAttribute("disabledBreakpoint", "true");
            if (props.condition)
                scriptRow.setAttribute("condition", "true");
        }
    }});


}

function getCallingFrame(frame)
{
    try
    {
        do
        {
            frame = frame.callingFrame;
            if (!(Firebug.filterSystemURLs && isSystemURL(normalizeURL(frame.script.fileName))))
                return frame;
        }
        while (frame);
    }
    catch (exc)
    {
    }
    return null;
}


function getFrameScopeWindowAncestor(frame)  // walk script scope chain to bottom, null unless a Window
{
    var scope = frame.scope;
    if (scope)
    {
        while(scope.jsParent)
            scope = scope.jsParent;

        if (scope.jsClassName == "Window" || scope.jsClassName == "ChromeWindow")
            return  scope.getWrappedValue();

    }
    else
        return null;
}

function getFrameWindow(frame)
{
    var result = {};
    if (frame.eval("window", "", 1, result))
    {
        var win = result.value.getWrappedValue();
        return getRootWindow(win);
    }
}

function getFrameContext(frame)
{
    var win = getFrameScopeWindowAncestor(frame);
    return win ? TabWatcher.getContextByWindow(win) : null;
}

function cacheAllScripts(context)
{
    return;
    // TODO the scripts should all be ready
    for (var url in context.sourceFileMap)
        context.sourceFileMap[url].cache(context);
}

function countBreakpoints(context)
{
    var count = 0;
    for (var url in context.sourceFileMap)
    {
        fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
        {
            ++count;
        }});
    }
    return count;
}

function ArrayEnumerator(array)
{
    this.index = 0;
    this.array = array;
    this.hasMoreElements = function()
    {
        return (this.index < array.length);
    }
    this.getNext = function()
    {
        return this.array[++this.index];
    }
}

// ************************************************************************************************

Firebug.registerActivableModule(Firebug.Debugger);
Firebug.registerPanel(BreakpointsPanel);
Firebug.registerPanel(CallstackPanel);
Firebug.registerPanel(Firebug.ScriptPanel);

// ************************************************************************************************

}});
