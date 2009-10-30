/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const jsdIStackFrame = Ci.jsdIStackFrame;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const insertSliceSize = 18;
const insertInterval = 40;

const ignoreVars =
{
    "__firebug__": 1,
    "eval": 1,

    // We are forced to ignore Java-related variables, because
    // trying to access them causes browser freeze
    "java": 1,
    "sun": 1,
    "Packages": 1,
    "JavaArray": 1,
    "JavaMember": 1,
    "JavaObject": 1,
    "JavaClass": 1,
    "JavaPackage": 1,
    "_firebug": 1,
    "_FirebugConsole": 1,
    "_FirebugCommandLine": 1,
};

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const RowTag =
    TR({class: "memberRow $member.open $member.type\\Row", $hasChildren: "$member.hasChildren", role : 'presentation',
        level: "$member.level"},
        TD({class: "memberLabelCell", style: "padding-left: $member.indent\\px", role : 'presentation'},
            DIV({class: "memberLabel $member.type\\Label"},
                SPAN({}, "$member.name")
            )
        ),
        TD({class: "memberValueCell", role : 'presentation'},
            TAG("$member.tag", {object: "$member.value"})
        )
    );

const WatchRowTag =
    TR({class: "watchNewRow", level: 0},
        TD({class: "watchEditCell", colspan: 2},
            DIV({class: "watchEditBox a11yFocusNoTab", role: "button", 'tabindex' : '0',
                'aria-label' : $STR('press enter to add new watch expression')},
                    $STR("NewWatch")
            )
        )
    );

const SizerRow =
    TR({role : 'presentation'},
        TD({width: "30%"}),
        TD({width: "70%"})
    );

const DirTablePlate = domplate(Firebug.Rep,
{
    tag:
        TABLE({class: "domTable", cellpadding: 0, cellspacing: 0, onclick: "$onClick", role :"tree", 'aria-label' : 'DOM properties'},
            TBODY({role: 'presentation'},
                SizerRow,
                FOR("member", "$object|memberIterator", RowTag)
            )
        ),

    watchTag:
        TABLE({class: "domTable", cellpadding: 0, cellspacing: 0,
               _toggles: "$toggles", _domPanel: "$domPanel", onclick: "$onClick", role : 'tree'},
            TBODY({role : 'presentation'},
                SizerRow,
                WatchRowTag
            )
        ),

    tableTag:
        TABLE({class: "domTable", cellpadding: 0, cellspacing: 0,
            _toggles: "$toggles", _domPanel: "$domPanel", onclick: "$onClick", role : 'tree', 'aria-label' : 'DOM properties'},
            TBODY({role : 'presentation'},
                SizerRow
            )
        ),

    rowTag:
        FOR("member", "$members", RowTag),

    memberIterator: function(object, level)
    {
        return getMembers(object, level);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    onClick: function(event)
    {
        if (!isLeftClick(event))
            return;

        var row = getAncestorByClass(event.target, "memberRow");
        var label = getAncestorByClass(event.target, "memberLabel");
        if (label && hasClass(row, "hasChildren"))
        {
            var row = label.parentNode.parentNode;
            this.toggleRow(row);
        }
        else
        {
            var object = Firebug.getRepObject(event.target);
            if (typeof(object) == "function")
            {
                Firebug.chrome.select(object, "script");
                cancelEvent(event);
            }
            else if (event.detail == 2 && !object)
            {
                var panel = row.parentNode.parentNode.domPanel;
                if (panel)
                {
                    var rowValue = panel.getRowPropertyValue(row);
                    if (typeof(rowValue) == "boolean")
                        panel.setPropertyValue(row, !rowValue);
                    else
                        panel.editProperty(row);

                    cancelEvent(event);
                }
            }
        }
    },

    toggleRow: function(row)
    {
        var level = parseInt(row.getAttribute("level"));
        var toggles = row.parentNode.parentNode.toggles;

        if (hasClass(row, "opened"))
        {
            removeClass(row, "opened");

            if (toggles)
            {
                var path = getPath(row);

                // Remove the path from the toggle tree
                for (var i = 0; i < path.length; ++i)
                {
                    if (i == path.length-1)
                        delete toggles[path[i]];
                    else
                        toggles = toggles[path[i]];
                }
            }

            var rowTag = this.rowTag;
            var tbody = row.parentNode;

            setTimeout(function()
            {
                for (var firstRow = row.nextSibling; firstRow; firstRow = row.nextSibling)
                {
                    if (parseInt(firstRow.getAttribute("level")) <= level)
                        break;

                    tbody.removeChild(firstRow);
                }
            }, row.insertTimeout ? row.insertTimeout : 0);
        }
        else
        {
            setClass(row, "opened");

            if (toggles)
            {
                var path = getPath(row);

                // Mark the path in the toggle tree
                for (var i = 0; i < path.length; ++i)
                {
                    var name = path[i];
                    if (toggles.hasOwnProperty(name))
                        toggles = toggles[name];
                    else
                        toggles = toggles[name] = {};
                }
            }

            var value = row.lastChild.firstChild.repObject;
            var members = getMembers(value, level+1);

            var rowTag = this.rowTag;
            var lastRow = row;

            var delay = 0;
            var setSize = members.length;
            var rowCount = 1;
            while (members.length)
            {
                setTimeout(function(slice, isLast)
                {
                    if (lastRow.parentNode)
                    {
                        var result = rowTag.insertRows({members: slice}, lastRow);
                        lastRow = result[1];
                        dispatch([Firebug.A11yModel], 'onMemberRowSliceAdded', [null, result, rowCount, setSize]);
                        rowCount += insertSliceSize;
                    }
                    if (isLast)
                        delete row.insertTimeout;
                }, delay, members.splice(0, insertSliceSize), !members.length);

                delay += insertInterval;
            }

            row.insertTimeout = delay;
        }
    }
});

const ToolboxPlate = domplate(
{
    tag:
        DIV({class: "watchToolbox", _domPanel: "$domPanel", onclick: "$onClick"},
            IMG({class: "watchDeleteButton closeButton", src: "blank.gif"})
        ),

    onClick: function(event)
    {
        var toolbox = event.currentTarget;
        toolbox.domPanel.deleteWatch(toolbox.watchRow);
    }
});

// ************************************************************************************************

Firebug.DOMBasePanel = function() {}

Firebug.DOMBasePanel.prototype = extend(Firebug.ActivablePanel,
{
    tag: DirTablePlate.tableTag,

    getRealObject: function(object)
    {
        // TODO: Move this to some global location
        // TODO: Unwrapping should be centralized rather than sprinkling it around ad hoc.
        // TODO: We might be able to make this check more authoritative with QueryInterface.
        if (!object) return object;
        if (object.wrappedJSObject) return object.wrappedJSObject;
        return object;
    },

    rebuild: function(update, scrollTop)
    {
        dispatch([Firebug.A11yModel], 'onBeforeDomUpdateSelection', [this]);
        var members = getMembers(this.selection);
        expandMembers(members, this.toggles, 0, 0);

        this.showMembers(members, update, scrollTop);
    },

    showMembers: function(members, update, scrollTop)
    {
        // If we are still in the midst of inserting rows, cancel all pending
        // insertions here - this is a big speedup when stepping in the debugger
        if (this.timeouts)
        {
            for (var i = 0; i < this.timeouts.length; ++i)
                this.context.clearTimeout(this.timeouts[i]);
            delete this.timeouts;
        }

        if (!members.length)
            return this.showEmptyMembers();

        var panelNode = this.panelNode;
        var priorScrollTop = scrollTop == undefined ? panelNode.scrollTop : scrollTop;

        // If we are asked to "update" the current view, then build the new table
        // offscreen and swap it in when it's done
        var offscreen = update && panelNode.firstChild;
        var dest = offscreen ? this.document : panelNode;

        var table = this.tag.replace({domPanel: this, toggles: this.toggles}, dest);
        var tbody = table.lastChild;
        var rowTag = DirTablePlate.rowTag;

        // Insert the first slice immediately
        var setSize = members.length;
        var slice = members.splice(0, insertSliceSize);
        var result = rowTag.insertRows({members: slice}, tbody.lastChild);
        var rowCount = 1;
        var panel = this;
        dispatch([Firebug.A11yModel], 'onMemberRowSliceAdded', [panel, result, rowCount, setSize]);
        var timeouts = [];

        var delay = 0;
        while (members.length)
        {
            timeouts.push(this.context.setTimeout(function(slice)
            {
                result = rowTag.insertRows({members: slice}, tbody.lastChild);
                rowCount += insertSliceSize;
                dispatch([Firebug.A11yModel], 'onMemberRowSliceAdded', [panel, result, rowCount, setSize]);

                if ((panelNode.scrollHeight+panelNode.offsetHeight) >= priorScrollTop)
                    panelNode.scrollTop = priorScrollTop;
            }, delay, members.splice(0, insertSliceSize)));

            delay += insertInterval;
        }

        if (offscreen)
        {
            timeouts.push(this.context.setTimeout(function()
            {
                if (panelNode.firstChild)
                    panelNode.replaceChild(table, panelNode.firstChild);
                else
                    panelNode.appendChild(table);

                // Scroll back to where we were before
                panelNode.scrollTop = priorScrollTop;
            }, delay));
        }
        else
        {
            timeouts.push(this.context.setTimeout(function()
            {
                panelNode.scrollTop = scrollTop == undefined ? 0 : scrollTop;
            }, delay));
        }
        this.timeouts = [];
    },

    showEmptyMembers: function()
    {
        FirebugReps.Warning.tag.replace({object: "NoMembersWarning"}, this.panelNode);
    },

    findPathObject: function(object)
    {
        var pathIndex = -1;
        for (var i = 0; i < this.objectPath.length; ++i)
        {
            if (this.getPathObject(i) == object)
                return i;
        }

        return -1;
    },

    getPathObject: function(index)
    {
        var object = this.objectPath[index];
        if (object instanceof Property)
            return object.getObject();
        else
            return object;
    },

    getRowObject: function(row)
    {
        var object = getRowOwnerObject(row);
        return object ? object : this.selection;
    },

    getRowPropertyValue: function(row)
    {
        var object = this.getRowObject(row);
        object = this.getRealObject(object);
        if (object)
        {
            var propName = getRowName(row);

            if (object instanceof jsdIStackFrame)
                return Firebug.Debugger.evaluate(propName, this.context);
            else
                return object[propName];
        }
    },

    copyProperty: function(row)
    {
        var value = this.getRowPropertyValue(row);
        copyToClipboard(value);
    },

    editProperty: function(row, editValue)
    {
        if (hasClass(row, "watchNewRow"))
        {
            if (this.context.stopped)
                Firebug.Editor.startEditing(row, "");
            else if (Firebug.Console.isAlwaysEnabled())  // not stopped in debugger, need command line
            {
                if (Firebug.CommandLine.onCommandLineFocus())
                    Firebug.Editor.startEditing(row, "");
                else
                    row.innerHTML = $STR("warning.Command line blocked?");
            }
            else
                row.innerHTML = $STR("warning.Console must be enabled");
        }
        else if (hasClass(row, "watchRow"))
            Firebug.Editor.startEditing(row, getRowName(row));
        else
        {
            var object = this.getRowObject(row);
            this.context.thisValue = object;

            if (!editValue)
            {
                var propValue = this.getRowPropertyValue(row);

                var type = typeof(propValue);
                if (type == "undefined" || type == "number" || type == "boolean")
                    editValue = propValue;
                else if (type == "string")
                    editValue = "\"" + escapeJS(propValue) + "\"";
                else if (propValue == null)
                    editValue = "null";
                else if (object instanceof Window || object instanceof jsdIStackFrame)
                    editValue = getRowName(row);
                else
                    editValue = "this." + getRowName(row);
            }


            Firebug.Editor.startEditing(row, editValue);
        }
    },

    deleteProperty: function(row)
    {
        if (hasClass(row, "watchRow"))
            this.deleteWatch(row);
        else
        {
            var object = getRowOwnerObject(row);
            if (!object)
                object = this.selection;
            object = this.getRealObject(object);

            if (object)
            {
                var name = getRowName(row);
                try
                {
                    delete object[name];
                }
                catch (exc)
                {
                    return;
                }

                this.rebuild(true);
                this.markChange();
            }
        }
    },

    setPropertyValue: function(row, value)  // value must be string
    {
        var name = getRowName(row);
        if (name == "this")
            return;

        var object = this.getRowObject(row);
        object = this.getRealObject(object);
        if (object && !(object instanceof jsdIStackFrame))
        {
             // unwrappedJSObject.property = unwrappedJSObject
             Firebug.CommandLine.evaluate(value, this.context, object, this.context.getGlobalScope(),
                 function success(result, context)
                 {
                     object[name] = result;
                 },
                 function failed(exc, context)
                 {
                     try
                     {
                         object[name] = String(value);  // unwrappedJSobject.property = string
                     }
                     catch (exc)
                     {
                         return;
                     }
                  }
             );
        }
        else if (this.context.stopped)
        {
            try
            {
                Firebug.CommandLine.evaluate(name+"="+value, this.context);
            }
            catch (exc)
            {
                try
                {
                    // See catch block above...
                    object[name] = String(value); // unwrappedJSobject.property = string
                }
                catch (exc)
                {
                    return;
                }
            }
        }

        this.rebuild(true);
        this.markChange();
    },

    highlightRow: function(row)
    {
        if (this.highlightedRow)
            cancelClassTimed(this.highlightedRow, "jumpHighlight", this.context);

        this.highlightedRow = row;

        if (row)
            setClassTimed(row, "jumpHighlight", this.context);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    initialize: function()
    {
        this.objectPath = [];
        this.propertyPath = [];
        this.viewPath = [];
        this.pathIndex = -1;
        this.toggles = {};

        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        var view = this.viewPath[this.pathIndex];
        if (view && this.panelNode.scrollTop)
            view.scrollTop = this.panelNode.scrollTop;

        state.pathIndex = this.pathIndex;
        state.viewPath = this.viewPath;
        state.propertyPath = this.propertyPath;
        if (this.propertyPath.length > 0 && !this.propertyPath[1])
            state.firstSelection = persistObject(this.getPathObject(1), this.context);

        Firebug.Panel.destroy.apply(this, arguments);
    },

    show: function(state)
    {
        if (this.context.loaded && !this.selection)
        {
            if (!state)
            {
                this.select(null);
                return;
            }

            this.viewPath = state.viewPath;
            this.propertyPath = state.propertyPath;

            var selectObject = defaultObject = this.getDefaultSelection(this.context);

            if (state.firstSelection)
            {
                var restored = state.firstSelection(this.context);
                if (restored)
                {
                    selectObject = restored;
                    this.objectPath = [defaultObject, restored];
                }
                else
                    this.objectPath = [defaultObject];
            }
            else
                this.objectPath = [defaultObject];

            if (this.propertyPath.length > 1)
            {
                for (var i = 1; i < this.propertyPath.length; ++i)
                {
                    var name = this.propertyPath[i];
                    if (!name)
                        continue;

                    var object = selectObject;
                    try
                    {
                        selectObject = object[name];
                    }
                    catch (exc)
                    {
                        selectObject = null;
                    }

                    if (selectObject)
                    {
                        this.objectPath.push(new Property(object, name));
                    }
                    else
                    {
                        // If we can't access a property, just stop
                        this.viewPath.splice(i);
                        this.propertyPath.splice(i);
                        this.objectPath.splice(i);
                        selectObject = this.getPathObject(this.objectPath.length-1);
                        break;
                    }
                }
            }

            var selection = state.pathIndex <= this.objectPath.length-1
                ? this.getPathObject(state.pathIndex)
                : this.getPathObject(this.objectPath.length-1);

            this.select(selection);
        }
    },

    hide: function()
    {
        var view = this.viewPath[this.pathIndex];
        if (view && this.panelNode.scrollTop)
            view.scrollTop = this.panelNode.scrollTop;
    },

    supportsObject: function(object)
    {
        if (object == null)
            return 1000;

        if (typeof(object) == "undefined")
            return 1000;
        else if (object instanceof SourceLink)
            return 0;
        else
            return 1; // just agree to support everything but not agressively.
    },

    refresh: function()
    {
        this.rebuild(true);
    },

    updateSelection: function(object)
    {
        var previousIndex = this.pathIndex;
        var previousView = previousIndex == -1 ? null : this.viewPath[previousIndex];

        var newPath = this.pathToAppend;
        delete this.pathToAppend;

        var pathIndex = this.findPathObject(object);
        if (newPath || pathIndex == -1)
        {
            this.toggles = {};

            if (newPath)
            {
                // Remove everything after the point where we are inserting, so we
                // essentially replace it with the new path
                if (previousView)
                {
                    if (this.panelNode.scrollTop)
                        previousView.scrollTop = this.panelNode.scrollTop;

                    this.objectPath.splice(previousIndex+1);
                    this.propertyPath.splice(previousIndex+1);
                    this.viewPath.splice(previousIndex+1);
                }

                var value = this.getPathObject(previousIndex);
                if (!value)
                {
                    return;
                }

                for (var i = 0; i < newPath.length; ++i)
                {
                    var name = newPath[i];
                    var object = value;
                    try
                    {
                        value = value[name];
                    }
                    catch(exc)
                    {
                        return;
                    }

                    ++this.pathIndex;
                    this.objectPath.push(new Property(object, name));
                    this.propertyPath.push(name);
                    this.viewPath.push({toggles: this.toggles, scrollTop: 0});
                }
            }
            else
            {
                this.toggles = {};

                var win = this.context.getGlobalScope();
                if (object == win)
                {
                    this.pathIndex = 0;
                    this.objectPath = [win];
                    this.propertyPath = [null];
                    this.viewPath = [{toggles: this.toggles, scrollTop: 0}];
                }
                else
                {
                    this.pathIndex = 1;
                    this.objectPath = [win, object];
                    this.propertyPath = [null, null];
                    this.viewPath = [
                        {toggles: {}, scrollTop: 0},
                        {toggles: this.toggles, scrollTop: 0}
                    ];
                }
            }

            this.panelNode.scrollTop = 0;
            this.rebuild();
        }
        else
        {
            this.pathIndex = pathIndex;

            var view = this.viewPath[pathIndex];
            this.toggles = view.toggles;

            // Persist the current scroll location
            if (previousView && this.panelNode.scrollTop)
                previousView.scrollTop = this.panelNode.scrollTop;

            this.rebuild(false, view.scrollTop);
        }

    },

    getObjectPath: function(object)
    {
        return this.objectPath;
    },

    getDefaultSelection: function()
    {
        return this.context.getGlobalScope();
    },

    updateOption: function(name, value)
    {
        const optionMap = {showUserProps: 1, showUserFuncs: 1, showDOMProps: 1,
            showDOMFuncs: 1, showDOMConstants: 1};
        if ( optionMap.hasOwnProperty(name) )
            this.rebuild(true);
    },

    getOptionsMenuItems: function()
    {
        return [
            optionMenu("ShowUserProps", "showUserProps"),
            optionMenu("ShowUserFuncs", "showUserFuncs"),
            optionMenu("ShowDOMProps", "showDOMProps"),
            optionMenu("ShowDOMFuncs", "showDOMFuncs"),
            optionMenu("ShowDOMConstants", "showDOMConstants"),
            "-",
            {label: "Refresh", command: bindFixed(this.rebuild, this, true) }
        ];
    },

    getContextMenuItems: function(object, target)
    {
        var row = getAncestorByClass(target, "memberRow");

        var items = [];

        if (row)
        {
            var rowName = getRowName(row);
            var rowObject = this.getRowObject(row);
            var rowValue = this.getRowPropertyValue(row);

            var isWatch = hasClass(row, "watchRow");
            var isStackFrame = rowObject instanceof jsdIStackFrame;

            if (typeof(rowValue) == "string" || typeof(rowValue) == "number")
            {
                // Functions already have a copy item in their context menu
                items.push(
                    "-",
                    {label: "CopyValue",
                        command: bindFixed(this.copyProperty, this, row) }
                );
            }

            items.push(
                "-",
                {label: isWatch ? "EditWatch" : (isStackFrame ? "EditVariable" : "EditProperty"),
                    command: bindFixed(this.editProperty, this, row) }
            );

            if (isWatch || (!isStackFrame && !isDOMMember(rowObject, rowName)))
            {
                items.push(
                    {label: isWatch ? "DeleteWatch" : "DeleteProperty",
                        command: bindFixed(this.deleteProperty, this, row) }
                );
            }
        }

        items.push(
            "-",
            {label: "Refresh", command: bindFixed(this.rebuild, this, true) }
        );

        return items;
    },

    getEditor: function(target, value)
    {
        if (!this.editor)
            this.editor = new DOMEditor(this.document);

        return this.editor;
    }
});

// ************************************************************************************************

var DOMMainPanel = Firebug.DOMPanel = function () {};

Firebug.DOMPanel.DirTable = DirTablePlate;

DOMMainPanel.prototype = extend(Firebug.DOMBasePanel.prototype,
{
    selectRow: function(row, target)
    {
        if (!target)
            target = row.lastChild.firstChild;

        if (!target || !target.repObject)
            return;

        this.pathToAppend = getPath(row);

        // If the object is inside an array, look up its index
        var valueBox = row.lastChild.firstChild;
        if (hasClass(valueBox, "objectBox-array"))
        {
            var arrayIndex = FirebugReps.Arr.getItemIndex(target);
            this.pathToAppend.push(arrayIndex);
        }

        // Make sure we get a fresh status path for the object, since otherwise
        // it might find the object in the existing path and not refresh it
        Firebug.chrome.clearStatusPath();

        this.select(target.repObject, true);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    onClick: function(event)
    {
        var repNode = Firebug.getRepNode(event.target);
        if (repNode)
        {
            var row = getAncestorByClass(event.target, "memberRow");
            if (row)
            {
                this.selectRow(row, repNode);
                cancelEvent(event);
            }
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "dom",
    searchable: true,
    statusSeparator: ">",

    initialize: function()
    {
        this.onClick = bind(this.onClick, this);

        Firebug.DOMBasePanel.prototype.initialize.apply(this, arguments);
    },

    initializeNode: function(oldPanelNode)
    {
        this.panelNode.addEventListener("click", this.onClick, false);
        dispatch([Firebug.A11yModel], 'onInitializeNode', [this, 'console']);
    },

    destroyNode: function()
    {
        this.panelNode.removeEventListener("click", this.onClick, false);
        dispatch([Firebug.A11yModel], 'onDestroyNode', [this, 'console']);
    },

    search: function(text, reverse)
    {
        if (!text)
        {
            delete this.currentSearch;
            this.highlightRow(null);
            return false;
        }

        var row;
        if (this.currentSearch && text == this.currentSearch.text)
            row = this.currentSearch.findNext(true, undefined, reverse, Firebug.searchCaseSensitive);
        else
        {
            function findRow(node) { return getAncestorByClass(node, "memberRow"); }
            this.currentSearch = new TextSearch(this.panelNode, findRow);
            row = this.currentSearch.find(text, reverse, Firebug.searchCaseSensitive);
        }

        if (row)
        {
            var sel = this.document.defaultView.getSelection();
            sel.removeAllRanges();
            sel.addRange(this.currentSearch.range);

            scrollIntoCenterView(row, this.panelNode);

            this.highlightRow(row);
            dispatch([Firebug.A11yModel], 'onDomSearchMatchFound', [this, text, row]);
            return true;
        }
        else
        {
            dispatch([Firebug.A11yModel], 'onDomSearchMatchFound', [this, text, null]);
            return false;
        }
    }
});

// ************************************************************************************************

function DOMSidePanel() {}

DOMSidePanel.prototype = extend(Firebug.DOMBasePanel.prototype,
{
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "domSide",
    parentPanel: "html",
    order: 3,

    initializeNode: function(oldPanelNode)
    {
        dispatch([Firebug.A11yModel], 'onInitializeNode', [this, 'console']);
    },

    destroyNode: function()
    {
        dispatch([Firebug.A11yModel], 'onDestroyNode', [this, 'console']);
    },
});

// ************************************************************************************************

function WatchPanel() {}

WatchPanel.prototype = extend(Firebug.DOMBasePanel.prototype,
{
    tag: DirTablePlate.watchTag,

    rebuild: function()
    {
        this.updateSelection(this.selection);
    },

    showEmptyMembers: function()
    {
        this.tag.replace({domPanel: this, toggles: {}}, this.panelNode);
    },

    addWatch: function(expression)
    {
        if (!this.watches)
            this.watches = [];

        this.watches.splice(0, 0, expression);
        this.rebuild(true);
    },

    removeWatch: function(expression)
    {
        if (!this.watches)
            return;

        var index = this.watches.indexOf(expression);
        if (index != -1)
            this.watches.splice(index, 1);
    },

    editNewWatch: function(value)
    {
        var watchNewRow = getElementByClass(this.panelNode, "watchNewRow");
        if (watchNewRow)
            this.editProperty(watchNewRow, value);
    },

    setWatchValue: function(row, value)
    {
        var rowIndex = getWatchRowIndex(row);
        this.watches[rowIndex] = value;
        this.rebuild(true);
    },

    deleteWatch: function(row)
    {
        var rowIndex = getWatchRowIndex(row);
        this.watches.splice(rowIndex, 1);
        this.rebuild(true);

        this.context.setTimeout(bindFixed(function()
        {
            this.showToolbox(null);
        }, this));
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    showToolbox: function(row)
    {
        var toolbox = this.getToolbox();
        if (row)
        {
            if (hasClass(row, "editing"))
                return;

            toolbox.watchRow = row;

            var offset = getClientOffset(row);
            toolbox.style.top = offset.y + "px";
            this.panelNode.appendChild(toolbox);
        }
        else
        {
            delete toolbox.watchRow;
            if (toolbox.parentNode)
                toolbox.parentNode.removeChild(toolbox);
        }
    },

    getToolbox: function()
    {
        if (!this.toolbox)
            this.toolbox = ToolboxPlate.tag.replace({domPanel: this}, this.document);

        return this.toolbox;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    onMouseDown: function(event)
    {
        var watchNewRow = getAncestorByClass(event.target, "watchNewRow");
        if (watchNewRow)
        {
            this.editProperty(watchNewRow);
            cancelEvent(event);
        }
    },

    onMouseOver: function(event)
    {
        var watchRow = getAncestorByClass(event.target, "watchRow");
        if (watchRow)
            this.showToolbox(watchRow);
    },

    onMouseOut: function(event)
    {
        if (isAncestor(event.relatedTarget, this.getToolbox()))
            return;

        var watchRow = getAncestorByClass(event.relatedTarget, "watchRow");
        if (!watchRow)
            this.showToolbox(null);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "watches",
    order: 0,
    parentPanel: "script",

    initialize: function()
    {
        this.onMouseDown = bind(this.onMouseDown, this);
        this.onMouseOver = bind(this.onMouseOver, this);
        this.onMouseOut = bind(this.onMouseOut, this);

        Firebug.DOMBasePanel.prototype.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        state.watches = this.watches;

        Firebug.Panel.destroy.apply(this, arguments);
    },

    show: function(state)
    {
        if (state && state.watches)
            this.watches = state.watches;
    },

    initializeNode: function(oldPanelNode)
    {
        this.panelNode.addEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.addEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.addEventListener("mouseout", this.onMouseOut, false);
        dispatch([Firebug.A11yModel], "onInitializeNode", [this, 'console']);
    },

    destroyNode: function()
    {
        this.panelNode.removeEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.removeEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.removeEventListener("mouseout", this.onMouseOut, false);
        dispatch([Firebug.A11yModel], "onDestroyNode", [this, 'console']);
    },

    refresh: function()
    {
        this.rebuild(true);

    },

    updateSelection: function(object)
    {
        dispatch([Firebug.A11yModel], 'onBeforeDomUpdateSelection', [this]);
        var frame = this.context.currentFrame;

        var newFrame = frame && frame.isValid && frame.script != this.lastScript;
        if (newFrame)
        {
            this.toggles = {};
            this.lastScript = frame.script;
        }

        var members = [];

        if (this.watches)
        {
            for (var i = 0; i < this.watches.length; ++i)
            {
                var expr = this.watches[i];
                var value = null;
                Firebug.CommandLine.evaluate(expr, this.context, null, this.context.getGlobalScope(),
                    function success(result, context)
                    {
                        value = result;
                    },
                    function failed(result, context)
                    {
                        var exc = result;
                        value = new ErrorCopy(exc+"");
                    }
                );

                addMember("watch", members, expr, value, 0);
            }
        }

        if (frame && frame.isValid)
        {
            var thisVar = frame.thisValue.getWrappedValue();
            addMember("user", members, "this", thisVar, 0);

            var scopeChain = this.generateScopeChain(frame.scope);
            addMember("scopes", members, "scopeChain", scopeChain, 0);

            members.push.apply(members, getMembers(scopeChain[0]));
        }

        expandMembers(members, this.toggles, 0, 0);
        this.showMembers(members, !newFrame);
    },

    generateScopeChain: function (scope) {
        var ret = [];
        while (scope) {
            var scopeVars;
            // getWrappedValue will not contain any variables for closure
            // scopes, so we want to special case this to get all variables
            // in all cases.
            if (scope.jsClassName == "Call") {
                scopeVars = {};
                var listValue = {value: null}, lengthValue = {value: 0};
                scope.getProperties(listValue, lengthValue);

                for (var i = 0; i < lengthValue.value; ++i)
                {
                    var prop = listValue.value[i];
                    var name = prop.name.getWrappedValue();
                    if (ignoreVars[name] == 1)
                    {
                        continue;
                    }

                    scopeVars[name] = prop.value.getWrappedValue();
                }
            } else {
                scopeVars = scope.getWrappedValue();
            }

            if (scopeVars && scopeVars.hasOwnProperty)
            {
                if (!scopeVars.hasOwnProperty("toString")) {
                    (function() {
                        var className = scope.jsClassName;
                        scopeVars.toString = function() {
                            return $STR(className + " Scope");
                        };
                    })();
                }

                ret.push(scopeVars);
            }
            else
            {
            }
            scope = scope.jsParent;
        }

        ret.toString = function() {
            return $STR("Scope Chain");
        };

        return ret;
    },

});

// ************************************************************************************************
// Local Helpers

function DOMEditor(doc)
{
    this.box = this.tag.replace({}, doc, this);
    this.input = this.box;

    this.tabNavigation = false;
    this.tabCompletion = true;
    this.completeAsYouType = false;
    this.fixedWidth = true;

    this.autoCompleter = Firebug.CommandLine.autoCompleter;
}

DOMEditor.prototype = domplate(Firebug.InlineEditor.prototype,
{
    tag: INPUT({class: "fixedWidthEditor a11yFocusNoTab", type: "text", title:$STR("NewWatch"),
                oninput: "$onInput", onkeypress: "$onKeyPress"}),

    endEditing: function(target, value, cancel)
    {
        // XXXjoe Kind of hackish - fix me
        delete this.panel.context.thisValue;

        if (cancel || value == "")
            return;

        var row = getAncestorByClass(target, "memberRow");
        dispatch([Firebug.A11yModel], 'onWatchEndEditing', [this.panel]);
        if (!row)
            this.panel.addWatch(value);
        else if (hasClass(row, "watchRow"))
            this.panel.setWatchValue(row, value);
        else
            this.panel.setPropertyValue(row, value);
    }
});

// ************************************************************************************************
// Local Helpers

function getMembers(object, level)  // we expect object to be user-level object wrapped in security blanket
{
    if (!level)
        level = 0;

    var ordinals = [], userProps = [], userClasses = [], userFuncs = [],
        domProps = [], domFuncs = [], domConstants = [];

    try
    {
        var domMembers = getDOMMembers(object);

        if (object.wrappedJSObject)
            var insecureObject = object.wrappedJSObject;
        else
            var insecureObject = object;

        for (var name in insecureObject)  // enumeration is safe
        {
            // Ignore only global variables (properties of the |window| object).
            // javascript.options.strict says ignoreVars is undefined.
            if (ignoreVars[name] == 1 && (object instanceof Window))
            {
                continue;
            }

            var val;
            try
            {
                val = insecureObject[name];  // getter is safe
            }
            catch (exc)
            {
                // Sometimes we get exceptions trying to access certain members
            }

            var ordinal = parseInt(name);
            if (ordinal || ordinal == 0)
            {
                addMember("ordinal", ordinals, name, val, level);
            }
            else if (typeof(val) == "function")
            {
                if (isClassFunction(val))
                    addMember("userClass", userClasses, name, val, level);
                else if (name in domMembers)
                    addMember("domFunction", domFuncs, name, val, level, domMembers[name]);
                else
                    addMember("userFunction", userFuncs, name, val, level);
            }
            else
            {
                var getterFunction = insecureObject.__lookupGetter__(name),
                    setterFunction = insecureObject.__lookupSetter__(name),
                    prefix = "";

                if(getterFunction && !setterFunction)
                    prefix = "get ";

                if (name in domMembers)
                    addMember("dom", domProps, (prefix+name), val, level, domMembers[name]);
                else if (name in domConstantMap)
                    addMember("dom", domConstants, (prefix+name), val, level);
                else
                    addMember("user", userProps, (prefix+name), val, level);
            }
        }
    }
    catch (exc)
    {
        // Sometimes we get exceptions just from trying to iterate the members
        // of certain objects, like StorageList, but don't let that gum up the works
        //throw exc;
    }

    function sortName(a, b) { return a.name > b.name ? 1 : -1; }
    function sortOrder(a, b) { return a.order > b.order ? 1 : -1; }

    var members = [];

    members.push.apply(members, ordinals);

    if (Firebug.showUserProps)
    {
        userProps.sort(sortName);
        members.push.apply(members, userProps);
    }

    if (Firebug.showUserFuncs)
    {
        userClasses.sort(sortName);
        members.push.apply(members, userClasses);

        userFuncs.sort(sortName);
        members.push.apply(members, userFuncs);
    }

    if (Firebug.showDOMProps)
    {
        domProps.sort(sortName);
        members.push.apply(members, domProps);
    }

    if (Firebug.showDOMFuncs)
    {
        domFuncs.sort(sortName);
        members.push.apply(members, domFuncs);
    }

    if (Firebug.showDOMConstants)
        members.push.apply(members, domConstants);

    return members;
}

function expandMembers(members, toggles, offset, level)  // recursion starts with offset=0, level=0
{
    var expanded = 0;
    for (var i = offset; i < members.length; ++i)
    {
        var member = members[i];
        if (member.level > level)
            break;

        if ( toggles.hasOwnProperty(member.name) )
        {
            member.open = "opened";  // member.level <= level && member.name in toggles.

            var newMembers = getMembers(member.value, level+1);  // sets newMembers.level to level+1

            var args = [i+1, 0];
            args.push.apply(args, newMembers);
            members.splice.apply(members, args);
            expanded += newMembers.length;
            i += newMembers.length + expandMembers(members, toggles[member.name], i+1, level+1);
        }
    }

    return expanded;
}

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

function isClassFunction(fn)
{
    try
    {
        for (var name in fn.prototype)
            return true;
    } catch (exc) {}
    return false;
}

function hasProperties(ob)
{
    try
    {
        for (var name in ob)
            return true;
    } catch (exc) {}
    return false;
}

function addMember(type, props, name, value, level, order)
{
    var rep = Firebug.getRep(value);    // do this first in case a call to instanceof reveals contents
    var tag = rep.shortTag ? rep.shortTag : rep.tag;

    var valueType = typeof(value);
    var hasChildren = hasProperties(value) && !(value instanceof ErrorCopy) &&
        (valueType == "function" || (valueType == "object" && value != null)
        || (valueType == "string" && value.length > Firebug.stringCropLength));

    props.push({
        name: name,
        value: value,
        type: type,
        rowClass: "memberRow-"+type,
        open: "",
        order: order,
        level: level,
        indent: level*16,
        hasChildren: hasChildren,
        tag: tag
    });
}

function getWatchRowIndex(row)
{
    var index = -1;
    for (; row && hasClass(row, "watchRow"); row = row.previousSibling)
        ++index;
    return index;
}

function getRowName(row)
{
    return row.firstChild.textContent;
}

function getRowValue(row)
{
    return row.lastChild.firstChild.repObject;
}

function getRowOwnerObject(row)
{
    var parentRow = getParentRow(row);
    if (parentRow)
        return getRowValue(parentRow);
}

function getParentRow(row)
{
    var level = parseInt(row.getAttribute("level"))-1;
    for (row = row.previousSibling; row; row = row.previousSibling)
    {
        if (parseInt(row.getAttribute("level")) == level)
            return row;
    }
}

function getPath(row)
{
    var name = getRowName(row);
    var path = [name];

    var level = parseInt(row.getAttribute("level"))-1;
    for (row = row.previousSibling; row; row = row.previousSibling)
    {
        if (parseInt(row.getAttribute("level")) == level)
        {
            var name = getRowName(row);
            path.splice(0, 0, name);

            --level;
        }
    }

    return path;
}

// ************************************************************************************************

Firebug.registerPanel(DOMMainPanel);
Firebug.registerPanel(DOMSidePanel);
Firebug.registerPanel(WatchPanel);

// ************************************************************************************************

}});

