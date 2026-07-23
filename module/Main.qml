import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

// KYM budget — the Basecamp editor. Pure-QML view (tutorial v4, Part 2): NO C++
// backend. State arrives from kym_core (snapshot poll + budgetChanged event) and
// edits go out through logos.callModule("kym_core", ...).
//
// Layout intent (post-UX-overhaul):
//   • Top bar = MONEY OPERATIONS only (expense/income/assign/move/target/reconcile).
//   • The LIST is where you build structure — inline "+ group", "+ category" per
//     group, and "+ account" in the Accounts section. Never via the top row.
//   • The GEAR opens a Settings view for setup/config: seed, pairing, group
//     budget, sync, diagnostics. Kept out of the everyday operating surface.
//   • Every account/category/type choice is a real DROPDOWN (Drop), never typing.
Item {
    id: root

    property string budgetJson: "{}"
    property string statusText: "…"
    property bool ready: false
    readonly property var budget: {
        try { return JSON.parse(budgetJson || "{}"); } catch (e) { return ({}); }
    }
    readonly property string status: statusText
    readonly property string month: budget.currentMonth || ""

    // Selection lists for the dropdowns.
    readonly property var accountNames: (budget.accounts || []).map(function (a) { return a.name; })
    readonly property var categoryNames: {
        var out = [];
        (budget.groups || []).forEach(function (g) {
            (g.categories || []).forEach(function (c) { out.push(c.name); });
        });
        return out;
    }
    readonly property var groupNames: (budget.groups || []).map(function (g) { return g.name; })
    // Income can only land in an on-budget ASSET account (checking/savings/cash) —
    // income to a credit card or tracking account isn't budgetable cash and would
    // break the books. The Income picker uses this narrower list.
    readonly property var incomeAccountNames: (budget.accounts || []).filter(function (a) {
        return a.onBudget && (a.type === "checking" || a.type === "savings" || a.type === "cash");
    }).map(function (a) { return a.name; })
    readonly property var accountTypes: ["checking", "savings", "creditCard", "tracking"]
    readonly property var targetTypes: ["monthly", "balance"]
    readonly property bool isEmpty: (budget.groups || []).length === 0 && (budget.accounts || []).length === 0

    // palette
    readonly property color bg: "#14161c"
    readonly property color panel: "#1c1f28"
    readonly property color line: "#2a2f3a"
    readonly property color fg: "#e7e9ee"
    readonly property color dim: "#8b93a7"
    readonly property color good: "#4ade80"
    readonly property color warn: "#f87171"
    // The accent follows the CURRENT budget's colour, so the whole UI tints per
    // budget — glance at it and you know which budget you're in. Falls back to the
    // default when the core doesn't report a colour (old core / single budget).
    readonly property color accent: (budget.currentBudgetColor && String(budget.currentBudgetColor).length) ? budget.currentBudgetColor : "#7dd3fc"

    // multiple budgets (gated on a core that reports them — old core → no switcher)
    readonly property var budgets: budget.budgets || []
    readonly property string currentBudgetName: budget.currentBudgetName || "My budget"
    readonly property bool hasMultiBudget: budget.currentBudget !== undefined
    // Attribution: the name stamped on transactions this device adds (shown on a
    // shared budget so you can see who did what). "" = off. Needs kym_core ≥ 0.6.3.
    readonly property string authorName: budget.authorName || ""
    readonly property bool hasAttribution: budget.authorName !== undefined

    property string action: ""       // money-operation form: "" | expense | income | assign | move | target | reconcile
    property bool showSettings: false // gear view
    property bool showTx: false       // transactions (activity) view — 📋 button
    property bool showDev: false      // dev raw event-log panel inside the tx view
    property bool addingGroup: false  // inline "+ group" row at the list bottom
    property bool addingAccount: false // inline "+ account" row in the Accounts section
    property bool addingBudget: false  // inline "new budget" row under the title
    property bool showArchived: false  // expand the "Archived" section at the list bottom
    property var editTxnData: null     // the txn object open in the edit sheet (null = closed)
    // Archived categories gathered across all groups (they carry an `archived` flag).
    readonly property var archivedCats: {
        var out = [];
        (budget.groups || []).forEach(function (g) {
            (g.categories || []).forEach(function (c) { if (c.archived) out.push(c); });
        });
        return out;
    }
    // The three top-level views (grid / settings / transactions) are mutually
    // exclusive; the grid shows when neither of the others is open.
    readonly property bool showGrid: !showSettings && !showTx
    function openTx(on) { root.showTx = on; if (on) root.showSettings = false; }

    // ---- toast ----
    property string toastText: ""
    property bool toastError: false
    Timer { id: toastTimer; interval: 3400; onTriggered: root.toastText = "" }
    function showToast(t, err) { root.toastText = t; root.toastError = err; toastTimer.restart(); }

    function callCore(method, args) {
        if (typeof logos === "undefined" || !logos.callModule) return "Logos bridge unavailable";
        return String(logos.callModule("kym_core", method, args || []));
    }
    // Normalize the bridge return into a budget-JSON string, or null. The bridge
    // may hand back raw JSON or a quoted/escaped JSON string — accept both.
    function asBudget(raw) {
        var s = (raw === undefined || raw === null) ? "" : String(raw).trim();
        if (s.length < 2) return null;
        if (s.charAt(0) === '"') { try { s = String(JSON.parse(s)).trim(); } catch (e) { return null; } }
        if (s.charAt(0) !== "{") return null;
        var obj = null;
        try { obj = JSON.parse(s); } catch (e) { return null; }
        if (!obj || obj.error !== undefined) return null;
        return s;
    }

    // ---- pairing QR (kym_core.pairingQr() → matrix; drawn on a Canvas) ----
    property var qrData: null
    function buildQr() {
        if (!(budget.pairingCode || "")) { root.qrData = null; return; }
        try {
            var res = callCore("pairingQr", []);
            for (var k = 0; k < 2 && typeof res === "string"; k++) res = JSON.parse(res);
            if (res && res.ok && res.n && res.cells && res.cells.length >= res.n * res.n) {
                root.qrData = { n: res.n, cells: res.cells };
                try { qrCanvas.requestPaint(); } catch (e2) {}
                return;
            }
        } catch (e) { }
        root.qrData = null;
    }

    // Number of events in a budget-JSON string (0 on parse failure). The event log
    // is the definitive "does this instance have the data" signal.
    function eventCountOf(jsonStr) {
        try { var o = JSON.parse(jsonStr); return (o && o.events && o.events.length) ? o.events.length : 0; }
        catch (e) { return 0; }
    }
    function refresh() {
        var b = asBudget(callCore("snapshot", []));
        if (!b) return;
        // Multi-instance guard: Basecamp round-robins callModule across several
        // kym_core instances; one that hasn't loaded the shared log yet returns a
        // budget with an EMPTY event log. Don't let that blank a populated view —
        // keep what we have and let the next poll (from a loaded instance) refresh
        // it. This was the "budget flickers empty every couple seconds" bug. A
        // genuine reset comes through a mutation result (run()), which bypasses this.
        if (eventCountOf(b) === 0 && eventCountOf(root.budgetJson) > 0) return;
        root.budgetJson = b;
    }
    // Inspect a mutation result. On success kym_core returns the FRESH budget JSON
    // (not ""), so we render straight from the instance that applied the edit.
    function run(result, okMsg) {
        var b = asBudget(result);
        if (b) { root.budgetJson = b; root.action = ""; showToast(okMsg || "Saved", false); return; }
        var r = (result === undefined || result === null) ? "" : String(result).trim();
        var ok = (r === "" || r === '""' || r === "null" || r === "undefined" || r === "{}" || r === "true");
        if (!ok) showToast(r.length > 100 ? r.substring(0, 100) + "…" : r, true);
        else { root.action = ""; showToast(okMsg || "Saved", false); }
        refresh();
    }
    function openAction(a) { root.action = (root.action === a ? "" : a); }
    function openSettings(on) { root.showSettings = on; if (on) { root.showTx = false; buildQr(); } }
    function moveFrom(name) { root.action = "move"; mvFrom.setValue(name); mvTo.setValue(""); mvAmt.text = ""; }

    // ---- month navigation ----
    // The viewed month; assign/move target it, and Available reflects everything
    // rolled forward up to it (the engine carries balances month to month).
    readonly property string viewMonth: budget.viewMonth || budget.currentMonth || ""
    readonly property string earliestMonth: budget.earliestMonth || viewMonth
    readonly property bool isCurrentMonth: budget.isCurrentMonth !== false
    // Month navigation needs kym_core >= 0.5.0 (setViewMonth + the viewMonth JSON
    // field). An older core is silently missing it — gate the stepper on the
    // field's presence so a version-skewed install shows a plain month label and
    // never fires setViewMonth (which an old core rejects with "invalid response").
    readonly property bool hasMonthNav: budget.viewMonth !== undefined
    // Shift a "YYYY-MM" by delta months.
    function monthShift(ym, delta) {
        var p = (ym || "").split("-"); if (p.length < 2) return ym;
        var y = parseInt(p[0]); var m = parseInt(p[1]) - 1 + delta;
        y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
        return y + "-" + (m + 1 < 10 ? "0" : "") + (m + 1);
    }
    function gotoMonth(ym) {
        var b = asBudget(callCore("setViewMonth", [ym]));
        if (b) { root.budgetJson = b; return; }
        showToast("Update kym_core to 0.5.0 for month navigation", true);
    }

    // ---- grid filter + collapsible groups ----
    property string filter: ""
    property var collapsed: ({})
    function toggleGroup(name) {
        var c = Object.assign({}, root.collapsed); c[name] = !c[name]; root.collapsed = c;
    }

    Connections {
        target: typeof logos !== "undefined" ? logos : null
        function onModuleEventReceived(moduleName, eventName, data) {
            if (moduleName !== "kym_core") return;
            if (eventName === "budgetChanged") {
                var b = root.asBudget(data && data.length ? data[0] : null);
                if (b) root.budgetJson = b;
            } else if (eventName === "statusChanged") {
                if (data && data.length) root.statusText = String(data[0]);
            }
        }
    }
    Timer { interval: 2500; running: true; repeat: true; onTriggered: root.refresh() }
    Component.onCompleted: {
        if (typeof logos !== "undefined" && logos.onModuleEvent) {
            logos.onModuleEvent("kym_core", "budgetChanged");
            logos.onModuleEvent("kym_core", "statusChanged");
        }
        root.ready = true; root.refresh();
    }

    // ---- shortcuts ----
    Shortcut { sequence: "Escape"; onActivated: { root.action = ""; root.showSettings = false; root.showTx = false; root.addingGroup = false; root.addingAccount = false; root.addingBudget = false; } }
    Shortcut { sequence: "Ctrl+E"; onActivated: root.openAction("expense") }
    Shortcut { sequence: "Ctrl+I"; onActivated: root.openAction("income") }
    Shortcut { sequence: "Ctrl+G"; onActivated: root.openAction("assign") }
    Shortcut { sequence: "Ctrl+M"; onActivated: root.openAction("move") }
    Shortcut { sequence: "Ctrl+T"; onActivated: root.openAction("target") }
    Shortcut { sequence: "Ctrl+F"; onActivated: filterField.forceActiveFocus() }

    // ---- reusable themed controls ----
    component Btn: Rectangle {
        property string label
        property bool active: false
        property bool primary: false
        signal clicked()
        implicitHeight: 30; implicitWidth: bt.implicitWidth + 22; radius: 6
        color: ma.containsMouse || active ? root.accent : (primary ? root.accent : root.panel)
        border.color: root.line; border.width: 1
        Text { id: bt; anchors.centerIn: parent; text: parent.label
               color: (ma.containsMouse || parent.active || parent.primary) ? root.bg : root.fg; font.pixelSize: 13 }
        MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: parent.clicked() }
    }
    component Field: TextField {
        color: root.fg; font.pixelSize: 13; selectByMouse: true
        placeholderTextColor: root.dim
        implicitWidth: 110; implicitHeight: 30
        background: Rectangle { color: "#0b0d12"; border.color: root.line; border.width: 1; radius: 5 }
    }
    // A REAL dropdown: click to open the list and SELECT — no typing. `.value` is
    // the chosen string ("" when nothing picked). setValue(v) selects by value.
    component Drop: ComboBox {
        id: dp
        property string placeholderText: ""
        property string value: (dp.currentIndex >= 0 && dp.model && dp.currentIndex < dp.model.length)
                               ? dp.model[dp.currentIndex] : ""
        function setValue(v) { dp.currentIndex = dp.model ? dp.model.indexOf(v) : -1; }
        editable: false
        currentIndex: -1
        font.pixelSize: 13
        implicitWidth: 150; implicitHeight: 30
        contentItem: Text {
            text: dp.currentIndex >= 0 ? dp.displayText : dp.placeholderText
            color: dp.currentIndex >= 0 ? root.fg : root.dim
            font.pixelSize: 13; leftPadding: 10; rightPadding: 26
            verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight
        }
        background: Rectangle { color: "#0b0d12"; border.color: dp.popup.visible ? root.accent : root.line; border.width: 1; radius: 5 }
        indicator: Text {
            x: dp.width - width - 9; y: (dp.height - height) / 2
            text: "▾"; color: root.dim; font.pixelSize: 11
        }
        delegate: ItemDelegate {
            width: dp.width; implicitHeight: 30
            highlighted: dp.highlightedIndex === index
            contentItem: Text { text: modelData; color: root.fg; font.pixelSize: 13; leftPadding: 6; verticalAlignment: Text.AlignVCenter }
            background: Rectangle { color: highlighted ? root.line : "#0b0d12" }
        }
        popup: Popup {
            y: dp.height + 2; width: dp.width; padding: 1
            implicitHeight: Math.min(contentItem.implicitHeight + 2, 260)
            contentItem: ListView {
                clip: true; implicitHeight: contentHeight
                model: dp.delegateModel; currentIndex: dp.highlightedIndex
                ScrollIndicator.vertical: ScrollIndicator { }
            }
            background: Rectangle { color: root.panel; border.color: root.accent; border.width: 1; radius: 5 }
        }
    }

    Rectangle {
        anchors.fill: parent
        color: bg

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10

            // ================= HEADER =================
            RowLayout {
                Layout.fillWidth: true
                spacing: 16
                ColumnLayout {
                    spacing: 4
                    RowLayout {
                        spacing: 12
                        Text { text: "KYM — Know Your Money"; color: fg; font.pixelSize: 20; font.bold: true }
                        // Budget switcher — the current budget, coloured, always
                        // visible. Click to switch or add. THE thing that makes
                        // "which budget am I in" unmistakable.
                        Rectangle {
                            visible: root.hasMultiBudget
                            implicitHeight: 28; implicitWidth: bswRow.implicitWidth + 22; radius: 14
                            color: bswMa.containsMouse ? root.line : root.panel
                            border.color: accent; border.width: 2
                            RowLayout {
                                id: bswRow; anchors.centerIn: parent; spacing: 7
                                Rectangle { implicitWidth: 11; implicitHeight: 11; radius: 6; color: accent }
                                Text { text: root.currentBudgetName; color: fg; font.pixelSize: 14; font.bold: true }
                                Text { text: "▾"; color: dim; font.pixelSize: 12 }
                            }
                            MouseArea { id: bswMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: budgetPop.open() }
                            Popup {
                                id: budgetPop
                                y: parent.height + 5; width: 250; padding: 4
                                background: Rectangle { color: root.panel; border.color: accent; border.width: 1; radius: 8 }
                                contentItem: ColumnLayout {
                                    spacing: 2
                                    Repeater {
                                        model: root.budgets
                                        delegate: Rectangle {
                                            Layout.fillWidth: true; implicitHeight: 32; radius: 6
                                            color: bItemMa.containsMouse ? root.line : "transparent"
                                            RowLayout {
                                                anchors.fill: parent; anchors.leftMargin: 8; anchors.rightMargin: 8; spacing: 8
                                                Rectangle { implicitWidth: 11; implicitHeight: 11; radius: 6; color: modelData.color || root.dim }
                                                Text { text: modelData.name; color: fg; font.pixelSize: 13; Layout.fillWidth: true; font.bold: modelData.current === true }
                                                Text { text: (modelData.events || 0) + " ev"; color: dim; font.pixelSize: 10 }
                                                Text { visible: modelData.current === true; text: "✓"; color: accent; font.pixelSize: 13 }
                                            }
                                            MouseArea { id: bItemMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                                onClicked: { budgetPop.close(); if (modelData.current !== true) run(callCore("selectBudget", [modelData.id]), "Switched to " + modelData.name); } }
                                        }
                                    }
                                    Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.line }
                                    Rectangle {
                                        Layout.fillWidth: true; implicitHeight: 32; radius: 6
                                        color: newBMa.containsMouse ? root.line : "transparent"
                                        Text { anchors.left: parent.left; anchors.leftMargin: 8; anchors.verticalCenter: parent.verticalCenter
                                               text: "＋  New budget"; color: accent; font.pixelSize: 13; font.bold: true }
                                        MouseArea { id: newBMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                            onClicked: { budgetPop.close(); root.addingBudget = true; newBudgetField.forceActiveFocus(); } }
                                    }
                                }
                            }
                        }
                    }
                    // Inline "new budget" input (opens from the switcher's ＋ New budget).
                    RowLayout {
                        visible: root.addingBudget
                        spacing: 6
                        Field { id: newBudgetField; placeholderText: "new budget name"; implicitWidth: 200
                                onAccepted: { if (text.trim() !== "") { run(callCore("createBudget", [text.trim()]), "Budget created — share its code only with people you want in it"); text = ""; root.addingBudget = false; } } }
                        Btn { label: "Create"; primary: true; onClicked: { if (newBudgetField.text.trim() !== "") { run(callCore("createBudget", [newBudgetField.text.trim()]), "Budget created"); newBudgetField.text = ""; root.addingBudget = false; } } }
                        Btn { label: "✕"; onClicked: { root.addingBudget = false; newBudgetField.text = ""; } }
                    }
                    // Month stepper: ‹ 2026-07 ›  + a "Today" jump when off the live month.
                    // Arrows only when the core supports navigation (hasMonthNav);
                    // otherwise a plain month label so an old core never errors.
                    RowLayout {
                        spacing: 8
                        Rectangle {
                            visible: root.hasMonthNav
                            implicitWidth: 24; implicitHeight: 24; radius: 5
                            enabled: root.viewMonth > root.earliestMonth
                            opacity: enabled ? 1 : 0.35
                            color: prevMa.containsMouse && enabled ? accent : panel
                            border.color: line; border.width: 1
                            Text { anchors.centerIn: parent; text: "‹"; font.pixelSize: 14; color: prevMa.containsMouse && parent.enabled ? bg : fg }
                            MouseArea { id: prevMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: if (parent.enabled) root.gotoMonth(root.monthShift(root.viewMonth, -1)) }
                        }
                        Text { text: root.viewMonth; color: fg; font.pixelSize: 14; font.bold: true
                               horizontalAlignment: Text.AlignHCenter; Layout.minimumWidth: 64 }
                        Rectangle {
                            visible: root.hasMonthNav
                            implicitWidth: 24; implicitHeight: 24; radius: 5
                            color: nextMa.containsMouse ? accent : panel
                            border.color: line; border.width: 1
                            Text { anchors.centerIn: parent; text: "›"; font.pixelSize: 14; color: nextMa.containsMouse ? bg : fg }
                            MouseArea { id: nextMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: root.gotoMonth(root.monthShift(root.viewMonth, 1)) }
                        }
                        Rectangle {
                            visible: root.hasMonthNav && !root.isCurrentMonth
                            implicitWidth: todayT.implicitWidth + 16; implicitHeight: 24; radius: 5
                            color: todayMa.containsMouse ? accent : "transparent"; border.color: accent; border.width: 1
                            Text { id: todayT; anchors.centerIn: parent; text: "Today"; font.pixelSize: 11; color: todayMa.containsMouse ? bg : accent }
                            MouseArea { id: todayMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: root.gotoMonth("") }
                        }
                        Text { text: "·  " + status; color: dim; font.pixelSize: 12; verticalAlignment: Text.AlignVCenter }
                    }
                }
                Item { Layout.fillWidth: true }
                // Ready to Assign
                Rectangle {
                    visible: !root.isEmpty
                    radius: 8; color: panel; border.color: line; border.width: 1
                    implicitWidth: rta.implicitWidth + 28; implicitHeight: 52
                    ColumnLayout {
                        id: rta; anchors.centerIn: parent; spacing: 0
                        Text { text: "Ready to Assign"; color: dim; font.pixelSize: 11; Layout.alignment: Qt.AlignHCenter }
                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: "" + (budget.readyToAssign || "0.00")
                            color: (budget.readyToAssignRaw < 0) ? warn : (budget.readyToAssignRaw === 0 ? good : accent)
                            font.pixelSize: 20; font.bold: true
                        }
                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: budget.readyToAssignRaw < 0 ? "⚠ over-assigned"
                                : (budget.readyToAssignRaw === 0 ? "✓ all assigned" : "to assign")
                            color: (budget.readyToAssignRaw < 0) ? warn : (budget.readyToAssignRaw === 0 ? good : dim)
                            font.pixelSize: 10
                        }
                    }
                }
                // 📋 → transactions / activity view
                Rectangle {
                    implicitWidth: 40; implicitHeight: 40; radius: 8
                    color: txMa.containsMouse || root.showTx ? accent : panel
                    border.color: line; border.width: 1
                    Text { anchors.centerIn: parent; text: "📋"; font.pixelSize: 18
                           color: (txMa.containsMouse || root.showTx) ? bg : fg }
                    MouseArea { id: txMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: root.openTx(!root.showTx) }
                    ToolTip.visible: txMa.containsMouse; ToolTip.text: "Transactions"
                }
                // Gear → settings
                Rectangle {
                    implicitWidth: 40; implicitHeight: 40; radius: 8
                    color: gearMa.containsMouse || root.showSettings ? accent : panel
                    border.color: line; border.width: 1
                    Text { anchors.centerIn: parent; text: "⚙"; font.pixelSize: 20
                           color: (gearMa.containsMouse || root.showSettings) ? bg : fg }
                    MouseArea { id: gearMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: root.openSettings(!root.showSettings) }
                    ToolTip.visible: gearMa.containsMouse; ToolTip.text: "Settings"
                }
            }

            // ================= SETTINGS VIEW =================
            Flickable {
                visible: root.showSettings
                Layout.fillWidth: true; Layout.fillHeight: true
                contentHeight: setCol.implicitHeight; clip: true
                ColumnLayout {
                    id: setCol
                    width: parent.width
                    spacing: 14

                    Text { text: "Settings"; color: fg; font.pixelSize: 16; font.bold: true }

                    // Your name (attribution) — gated on a core that reports it
                    Rectangle {
                        visible: root.hasAttribution
                        Layout.fillWidth: true; radius: 8; color: panel; border.color: line; border.width: 1
                        implicitHeight: nameCol.implicitHeight + 20
                        ColumnLayout {
                            id: nameCol; anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14; spacing: 6
                            Text { text: "Your name"; color: fg; font.pixelSize: 14; font.bold: true }
                            Text { text: "Stamped on transactions you add, so a shared budget shows who did what. Leave empty for no attribution."
                                   color: dim; font.pixelSize: 11; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                            RowLayout {
                                spacing: 8
                                Field {
                                    id: authorField; implicitWidth: 220; placeholderText: "e.g. Vašek"
                                    text: root.authorName
                                    onAccepted: run(callCore("setAuthorName", [text.trim()]), "Name saved")
                                }
                                Btn { label: "Save"; onClicked: run(callCore("setAuthorName", [authorField.text.trim()]), "Name saved") }
                            }
                        }
                    }

                    // Seed
                    Rectangle {
                        Layout.fillWidth: true; radius: 8; color: panel; border.color: line; border.width: 1
                        implicitHeight: seedCol.implicitHeight + 20
                        ColumnLayout {
                            id: seedCol; anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14; spacing: 6
                            Text { text: "Starter budget"; color: fg; font.pixelSize: 14; font.bold: true }
                            Text { text: "Seed accounts, groups, categories and this month's assignments so the budget is meaningful immediately. Only works on an empty budget."
                                   color: dim; font.pixelSize: 11; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                            Btn { label: "Seed starter budget"; primary: true; onClicked: run(callCore("loadDemo", []), "Starter budget added") }
                        }
                    }

                    // Pairing
                    Rectangle {
                        Layout.fillWidth: true; radius: 8; color: panel; border.color: line; border.width: 1
                        implicitHeight: pairCol.implicitHeight + 20
                        ColumnLayout {
                            id: pairCol; anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14; spacing: 8
                            Text { text: "Share this budget"; color: fg; font.pixelSize: 14; font.bold: true }
                            Text { text: "Show this code/QR on another device — your own phone/laptop, or a partner — to join THIS budget. It starts empty and syncs from scratch. Each budget is shared separately; a device you don't share it with never sees it."
                                   color: dim; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            RowLayout {
                                spacing: 14
                                Rectangle {
                                    visible: root.qrData !== null
                                    width: 172; height: 172; radius: 6; color: "#ffffff"
                                    Canvas {
                                        id: qrCanvas; anchors.fill: parent; anchors.margins: 8
                                        onPaint: {
                                            var ctx = getContext("2d"); ctx.reset();
                                            ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
                                            var d = root.qrData; if (!d || !d.n) return;
                                            var cell = width / d.n; ctx.fillStyle = "#000000";
                                            for (var y = 0; y < d.n; y++)
                                                for (var x = 0; x < d.n; x++)
                                                    if (d.cells[y * d.n + x])
                                                        ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
                                        }
                                    }
                                }
                                ColumnLayout {
                                    spacing: 4
                                    Text { text: root.qrData ? "Scan with the KYM phone app" : "Share this code to pair:"; color: dim; font.pixelSize: 11 }
                                    // Selectable (readOnly TextEdit) so you can drag-select + Ctrl+C;
                                    // the Copy buttons below are the one-click path.
                                    TextEdit {
                                        id: codeEdit
                                        text: (budget.pairingCode || "").replace(/(.{4})/g, "$1 ").trim()
                                        readOnly: true; selectByMouse: true; persistentSelection: true
                                        color: fg; font.pixelSize: 12; font.family: "monospace"
                                        Layout.maximumWidth: 320; wrapMode: TextEdit.WrapAnywhere
                                    }
                                    Text { text: "fingerprint: " + (budget.fingerprint || "—"); color: accent; font.pixelSize: 10 }
                                    RowLayout {
                                        spacing: 6
                                        Btn { label: "Copy code"; onClicked: { rawCode.selectAll(); rawCode.copy(); showToast("Pairing code copied", false); } }
                                        Btn { label: "Copy link"; onClicked: { rawLink.selectAll(); rawLink.copy(); showToast("Pairing link copied", false); } }
                                    }
                                    // Hidden holders of the RAW (unspaced) values for a clean clipboard copy.
                                    TextEdit { id: rawCode; opacity: 0; width: 0; height: 0; text: budget.pairingCode || "" }
                                    TextEdit { id: rawLink; opacity: 0; width: 0; height: 0; text: "kym://pair?s=" + (budget.pairingCode || "") }
                                }
                            }
                            RowLayout {
                                spacing: 8
                                Field { id: pairField; placeholderText: "paste another device's code / kym://pair link"; implicitWidth: 320 }
                                Btn { label: "Join a shared budget"; onClicked: run(callCore("pairWithCode", [pairField.text]), "Joined — confirm the fingerprint matches the other device") }
                            }
                        }
                    }

                    // Sync + diagnostics
                    Rectangle {
                        Layout.fillWidth: true; radius: 8; color: panel; border.color: line; border.width: 1
                        implicitHeight: syncCol.implicitHeight + 20
                        ColumnLayout {
                            id: syncCol; anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14; spacing: 8
                            Text { text: "Sync"; color: fg; font.pixelSize: 14; font.bold: true }
                            RowLayout {
                                spacing: 10
                                Btn { label: "Sync now"; onClicked: run(callCore("resync", []), "Asked peers + re-served our log") }
                                Text { text: status; color: dim; font.pixelSize: 12; verticalAlignment: Text.AlignVCenter }
                            }
                            Text {
                                visible: budget.sync !== undefined
                                color: dim; font.pixelSize: 11; Layout.fillWidth: true; wrapMode: Text.WordWrap
                                text: {
                                    var s = budget.sync; if (!s) return "";
                                    return "received " + s.rxSeen + " (decrypted " + s.rxOpened + ", failed " + s.rxOpenFail
                                        + ", new " + s.rxNew + ", duplicate " + s.rxDup + ")  ·  sent " + s.tx
                                        + "   —   failed>0 means traffic under a different household key; new is fresh data pulled in.";
                                }
                            }
                        }
                    }

                    Btn { label: "← Back to budget"; onClicked: root.openSettings(false) }
                }
            }

            // ================= TRANSACTIONS VIEW =================
            // A flat list of expenses & income folded from the log, plus a
            // collapsible developer panel that dumps the raw event log.
            Flickable {
                visible: root.showTx
                Layout.fillWidth: true; Layout.fillHeight: true
                contentHeight: txCol.implicitHeight; clip: true
                ColumnLayout {
                    id: txCol
                    width: parent.width
                    spacing: 4

                    RowLayout {
                        Layout.fillWidth: true
                        Text { text: "Transactions"; color: fg; font.pixelSize: 17; font.bold: true; topPadding: 2 }
                        Text { text: "  " + ((budget.transactions || []).length) + " total"; color: dim; font.pixelSize: 12 }
                        Item { Layout.fillWidth: true }
                        Btn { label: "← Back to budget"; onClicked: root.openTx(false) }
                    }

                    Text {
                        visible: (budget.transactions || []).length === 0
                        text: "No expenses or income yet."; color: dim; font.pixelSize: 13; topPadding: 8
                    }
                    // column headers
                    RowLayout {
                        visible: (budget.transactions || []).length > 0
                        Layout.fillWidth: true; Layout.topMargin: 6
                        Text { text: "DATE"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 100 }
                        Text { text: "CATEGORY"; color: dim; font.pixelSize: 11; Layout.fillWidth: true }
                        Text { text: "ACCOUNT"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 120 }
                        Text { text: "AMOUNT"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
                    }
                    Repeater {
                        model: budget.transactions || []
                        delegate: Rectangle {
                            Layout.fillWidth: true
                            implicitHeight: 32
                            color: txRowHover.hovered ? panel : "transparent"; radius: 6
                            HoverHandler { id: txRowHover }
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: 10; anchors.rightMargin: 10
                                Text { text: (modelData.date || "").substring(0, 10); color: dim; font.pixelSize: 13; Layout.preferredWidth: 100 }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 6
                                    Text { text: modelData.category || ""; color: fg; font.pixelSize: 14; elide: Text.ElideRight; Layout.maximumWidth: 360 }
                                    // Who added / last-edited it — only on a shared budget (author set).
                                    Text { visible: (modelData.author || "") !== ""; text: "· " + modelData.author
                                           color: dim; font.pixelSize: 11 }
                                    Item { Layout.fillWidth: true }
                                }
                                Text { text: modelData.account || ""; color: dim; font.pixelSize: 13; Layout.preferredWidth: 120; elide: Text.ElideRight }
                                Text {
                                    text: modelData.amount || ""
                                    color: modelData.kind === "income" ? good : fg
                                    font.pixelSize: 14; font.bold: true
                                    Layout.preferredWidth: 96; horizontalAlignment: Text.AlignRight
                                }
                                // Edit — on hover. Opens the shared edit sheet (which also
                                // holds Delete). Both are append-only: editTxn/deleteTxn add
                                // a txn.edit / txn.delete that the fold applies, sync-safe.
                                Rectangle {
                                    Layout.preferredWidth: 22; implicitHeight: 22; radius: 4
                                    visible: txRowHover.hovered || (root.editTxnData && root.editTxnData.id === modelData.id)
                                    color: editTxnMa.containsMouse ? accent : "transparent"
                                    Text { anchors.centerIn: parent; text: "✎"; font.pixelSize: 13; color: editTxnMa.containsMouse ? bg : dim }
                                    MouseArea { id: editTxnMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: { root.editTxnData = modelData; editTxnPop.open(); } }
                                    ToolTip.visible: editTxnMa.containsMouse; ToolTip.text: "Edit / delete"
                                }
                            }
                        }
                    }

                    // ── Developer: raw event log (collapsible) ──
                    Rectangle { Layout.fillWidth: true; Layout.topMargin: 18; implicitHeight: 1; color: line }
                    Text {
                        text: (root.showDev ? "▾ " : "▸ ") + "Developer — raw event log  (" + ((budget.events || []).length) + " events)"
                        color: accent; font.pixelSize: 12; font.bold: true; topPadding: 8; bottomPadding: 4
                        TapHandler { onTapped: root.showDev = !root.showDev }
                    }
                    Repeater {
                        model: root.showDev ? (budget.events || []) : []
                        delegate: Rectangle {
                            Layout.fillWidth: true
                            implicitHeight: devCol.implicitHeight + 8
                            color: (index % 2) ? "transparent" : "#0b0d12"; radius: 4
                            ColumnLayout {
                                id: devCol
                                anchors.left: parent.left; anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.leftMargin: 8; anchors.rightMargin: 8; spacing: 1
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 8
                                    Text { text: "#" + modelData.seq; color: dim; font.pixelSize: 11; font.family: "monospace" }
                                    Text { text: modelData.type || ""; color: accent; font.pixelSize: 12; font.bold: true; font.family: "monospace" }
                                    Item { Layout.fillWidth: true }
                                    Text { text: modelData.dev || ""; color: dim; font.pixelSize: 10; font.family: "monospace" }
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: JSON.stringify(modelData.payload || {})
                                    color: fg; font.pixelSize: 11; font.family: "monospace"
                                    wrapMode: Text.WrapAnywhere
                                }
                            }
                        }
                    }
                }
            }

            // ================= BUDGET VIEW ================= (hidden while Settings is open)
            // ---- operations command bar (money ops ONLY) ----
            Flow {
                visible: root.showGrid && !root.isEmpty
                Layout.fillWidth: true; spacing: 6
                Btn { label: "＋ Expense"; active: action === "expense"; onClicked: openAction("expense") }
                Btn { label: "＋ Income"; active: action === "income"; onClicked: openAction("income") }
                Btn { label: "Assign"; active: action === "assign"; onClicked: openAction("assign") }
                Btn { label: "Move"; active: action === "move"; onClicked: openAction("move") }
                Btn { label: "Target"; active: action === "target"; onClicked: openAction("target") }
                Btn { label: "Reconcile"; active: action === "reconcile"; onClicked: openAction("reconcile") }
                Field { id: filterField; placeholderText: "filter…  (Ctrl+F)"; implicitWidth: 160; onTextEdited: root.filter = text }
            }

            // ---- operation form (dropdowns, not typing) ----
            Rectangle {
                visible: root.showGrid && action !== ""
                Layout.fillWidth: true
                implicitHeight: 44
                color: panel; radius: 8; border.color: accent; border.width: 1
                RowLayout {
                    anchors.left: parent.left; anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 12; anchors.rightMargin: 12; spacing: 8

                    // The budget this operation lands in — coloured, right next to the
                    // fields, so an expense can never be booked to the wrong budget.
                    RowLayout {
                        visible: root.hasMultiBudget; spacing: 5
                        Rectangle { implicitWidth: 9; implicitHeight: 9; radius: 5; color: accent }
                        Text { text: root.currentBudgetName; color: accent; font.pixelSize: 12; font.bold: true }
                        Rectangle { implicitWidth: 1; implicitHeight: 22; color: line }
                    }

                    // Enter in the amount field submits the form (onAccepted) — same
                    // call as the button, so typing amount + Return is enough.
                    RowLayout { visible: action === "expense"; spacing: 8
                        Field { id: exAmt; placeholderText: "amount"; onAccepted: run(callCore("spend", [exAmt.text, exAcct.value, exCat.value])) }
                        Drop { id: exAcct; placeholderText: "account"; model: root.accountNames }
                        Drop { id: exCat; placeholderText: "category"; model: root.categoryNames }
                        Btn { label: "Add expense"; onClicked: run(callCore("spend", [exAmt.text, exAcct.value, exCat.value])) }
                    }
                    RowLayout { visible: action === "income"; spacing: 8
                        Field { id: inAmt; placeholderText: "amount"; onAccepted: run(callCore("income", [inAmt.text, inAcct.value])) }
                        Drop { id: inAcct; placeholderText: "account"; model: root.incomeAccountNames }  // asset accounts only
                        Btn { label: "Add income"; onClicked: run(callCore("income", [inAmt.text, inAcct.value])) }
                    }
                    RowLayout { visible: action === "assign"; spacing: 8
                        Drop { id: asgCat; placeholderText: "category"; model: root.categoryNames }
                        Field { id: asgAmt; placeholderText: "+ amount"; onAccepted: run(callCore("assign", [asgCat.value, root.month, asgAmt.text])) }
                        Btn { label: "Assign"; onClicked: run(callCore("assign", [asgCat.value, root.month, asgAmt.text])) }
                    }
                    RowLayout { visible: action === "move"; spacing: 8
                        Drop { id: mvFrom; placeholderText: "from category"; model: root.categoryNames }
                        Drop { id: mvTo; placeholderText: "to category"; model: root.categoryNames }
                        Field { id: mvAmt; placeholderText: "amount"; onAccepted: run(callCore("moveMoney", [mvFrom.value, mvTo.value, root.month, mvAmt.text])) }
                        Btn { label: "Move"; onClicked: run(callCore("moveMoney", [mvFrom.value, mvTo.value, root.month, mvAmt.text])) }
                    }
                    RowLayout { visible: action === "target"; spacing: 8
                        Drop { id: tgCat; placeholderText: "category"; model: root.categoryNames }
                        Drop { id: tgType; placeholderText: "type"; model: root.targetTypes; implicitWidth: 120 }
                        Field { id: tgAmt; placeholderText: "amount"; onAccepted: run(callCore("setTarget", [tgCat.value, tgType.value || "monthly", tgAmt.text, ""])) }
                        Btn { label: "Set target"; onClicked: run(callCore("setTarget", [tgCat.value, tgType.value || "monthly", tgAmt.text, ""])) }
                    }
                    RowLayout { visible: action === "reconcile"; spacing: 8
                        Drop { id: rcAcct; placeholderText: "account"; model: root.accountNames }
                        Field { id: rcActual; placeholderText: "bank balance"; onAccepted: run(callCore("reconcile", [rcAcct.value, rcActual.text])) }
                        Btn { label: "Reconcile"; onClicked: run(callCore("reconcile", [rcAcct.value, rcActual.text])) }
                    }
                    Item { Layout.fillWidth: true }
                    Btn { label: "✕"; onClicked: action = "" }
                }
            }

            // ---- column headers ----
            RowLayout {
                visible: root.showGrid && !root.isEmpty
                Layout.fillWidth: true
                Text { text: "CATEGORY"; color: dim; font.pixelSize: 11; Layout.fillWidth: true }
                Text { text: "ASSIGNED"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                Text { text: "ACTIVITY"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                Text { text: "AVAILABLE"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
            }

            // ================= EMPTY STATE =================
            // Hidden once you start adding a group, so the grid (which holds the
            // "new group" input) can take over — otherwise "＋ Add a group" set the
            // flag but its input was in the hidden grid and nothing appeared.
            ColumnLayout {
                visible: root.showGrid && root.isEmpty && !root.addingGroup
                Layout.fillWidth: true; Layout.fillHeight: true
                Item { Layout.fillHeight: true }
                Text { text: "Your budget is empty"; color: fg; font.pixelSize: 18; font.bold: true; Layout.alignment: Qt.AlignHCenter }
                Text { text: "Start with a ready-made budget, or build your own from the list."; color: dim; font.pixelSize: 13; Layout.alignment: Qt.AlignHCenter }
                Item { implicitHeight: 6 }
                Btn { label: "Seed a starter budget"; primary: true; Layout.alignment: Qt.AlignHCenter
                      onClicked: run(callCore("loadDemo", []), "Starter budget added") }
                Btn { label: "＋ Add a group"; Layout.alignment: Qt.AlignHCenter; onClicked: { root.addingGroup = true; groupNameField.forceActiveFocus(); } }
                Item { Layout.fillHeight: true }
            }

            // ================= THE GRID =================
            Flickable {
                visible: root.showGrid && (!root.isEmpty || root.addingGroup)
                Layout.fillWidth: true; Layout.fillHeight: true
                contentHeight: gridCol.implicitHeight; clip: true
                ColumnLayout {
                    id: gridCol
                    width: parent.width
                    spacing: 6

                    Repeater {
                        model: budget.groups || []
                        delegate: ColumnLayout {
                            id: grp
                            Layout.fillWidth: true
                            spacing: 0
                            property bool addingCat: false
                            readonly property string groupName: modelData.name
                            readonly property var matched: (modelData.categories || []).filter(function (c) {
                                if (c.archived) return false;   // archived → the collapsible Archived section
                                return root.filter === "" || c.name.toLowerCase().indexOf(root.filter.toLowerCase()) >= 0;
                            })
                            readonly property bool isCollapsed: (root.collapsed[modelData.name] === true) && root.filter === ""

                            // group header — collapse toggle + inline "+ category" + delete
                            RowLayout {
                                Layout.fillWidth: true
                                HoverHandler { id: grpHeadHover }
                                Text {
                                    text: (grp.isCollapsed ? "▸ " : "▾ ") + grp.groupName
                                    color: accent; font.pixelSize: 13; font.bold: true; topPadding: 8; bottomPadding: 4
                                    TapHandler { onTapped: root.toggleGroup(grp.groupName) }
                                }
                                Item { Layout.fillWidth: true; implicitHeight: 1 }
                                // Delete group — appears on hover; the core refuses unless the group is empty.
                                Rectangle {
                                    visible: grpHeadHover.hovered
                                    implicitWidth: 24; implicitHeight: 22; radius: 5
                                    color: delGrpMa.containsMouse ? warn : "transparent"; border.color: line; border.width: 1
                                    Text { anchors.centerIn: parent; text: "🗑"; font.pixelSize: 11; color: delGrpMa.containsMouse ? bg : dim }
                                    MouseArea { id: delGrpMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: run(callCore("deleteGroup", [grp.groupName]), "Group deleted") }
                                    ToolTip.visible: delGrpMa.containsMouse; ToolTip.text: "Delete group (must be empty)"
                                }
                                Rectangle {
                                    implicitWidth: 84; implicitHeight: 22; radius: 5
                                    color: addCatMa.containsMouse ? accent : "transparent"
                                    border.color: line; border.width: 1
                                    Text { anchors.centerIn: parent; text: "＋ category"; font.pixelSize: 10
                                           color: addCatMa.containsMouse ? bg : dim }
                                    MouseArea { id: addCatMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: { grp.addingCat = true; catNameField.forceActiveFocus(); } }
                                }
                            }

                            // inline add-category row (under the group header)
                            RowLayout {
                                visible: grp.addingCat
                                Layout.fillWidth: true; Layout.leftMargin: 10; spacing: 8
                                Field {
                                    id: catNameField; placeholderText: "new category in " + grp.groupName; implicitWidth: 240
                                    onAccepted: { if (text.trim() !== "") { run(callCore("addCategory", [text.trim(), grp.groupName]), "Category added"); text = ""; grp.addingCat = false; } }
                                }
                                Btn { label: "Add"; onClicked: { if (catNameField.text.trim() !== "") { run(callCore("addCategory", [catNameField.text.trim(), grp.groupName]), "Category added"); catNameField.text = ""; grp.addingCat = false; } } }
                                Btn { label: "✕"; onClicked: { grp.addingCat = false; catNameField.text = ""; } }
                            }

                            Repeater {
                                model: grp.isCollapsed ? [] : grp.matched
                                delegate: Rectangle {
                                    Layout.fillWidth: true
                                    implicitHeight: 34
                                    color: rowHover.hovered ? panel : "transparent"; radius: 6
                                    HoverHandler { id: rowHover }
                                    RowLayout {
                                        anchors.fill: parent
                                        anchors.leftMargin: 10; anchors.rightMargin: 10
                                        Text { text: modelData.name; color: fg; font.pixelSize: 14 }
                                        // Delete / archive — on hover, with a confirm. A history-free
                                        // category can be deleted; one WITH history is archived (hidden,
                                        // kept) and the core refuses unless its balance is 0.
                                        Rectangle {
                                            visible: rowHover.hovered || delConfirm.opened
                                            implicitWidth: 18; implicitHeight: 18; radius: 4
                                            color: delCatMa.containsMouse ? warn : "transparent"
                                            Text { anchors.centerIn: parent; text: modelData.canDelete === false ? "⊟" : "×"; font.pixelSize: 14; color: delCatMa.containsMouse ? bg : dim }
                                            MouseArea { id: delCatMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                                onClicked: delConfirm.open() }
                                            ToolTip.visible: delCatMa.containsMouse && !delConfirm.opened
                                            ToolTip.text: modelData.canDelete === false ? "Archive category (hidden, history kept)" : "Delete category"
                                            Popup {
                                                id: delConfirm
                                                y: parent.height + 3; width: 230; padding: 10
                                                background: Rectangle { color: root.panel; border.color: warn; border.width: 1; radius: 8 }
                                                contentItem: ColumnLayout {
                                                    spacing: 7
                                                    Text { text: (modelData.canDelete === false ? "Archive " : "Delete ") + "\"" + modelData.name + "\"?"
                                                           color: fg; font.pixelSize: 13; font.bold: true; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                                    Text { visible: modelData.canDelete === false
                                                           text: "It has history, so it's hidden (not deleted) — its balance must be 0 first."
                                                           color: dim; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                                    RowLayout {
                                                        Item { Layout.fillWidth: true }
                                                        Btn { label: "Cancel"; onClicked: delConfirm.close() }
                                                        Btn { label: modelData.canDelete === false ? "Archive" : "Delete"; primary: true
                                                              onClicked: { delConfirm.close();
                                                                  if (modelData.canDelete === false) run(callCore("archiveCategory", [modelData.name]), "Category archived");
                                                                  else run(callCore("deleteCategory", [modelData.name]), "Category deleted"); } }
                                                    }
                                                }
                                            }
                                        }
                                        Text { text: modelData.target || ""; color: modelData.targetOnTrack ? good : accent; font.pixelSize: 11; Layout.fillWidth: true; leftPadding: 10; verticalAlignment: Text.AlignVCenter }
                                        Item {
                                            id: asgCell
                                            Layout.preferredWidth: 110; implicitHeight: 28
                                            property bool editing: false
                                            Text {
                                                visible: !asgCell.editing; anchors.fill: parent
                                                text: "" + modelData.assigned
                                                color: cellHover.hovered ? accent : dim
                                                font.pixelSize: 14; horizontalAlignment: Text.AlignRight; verticalAlignment: Text.AlignVCenter
                                                HoverHandler { id: cellHover }
                                                TapHandler { onTapped: {
                                                    asgCell.editing = true;
                                                    asgField.text = Math.round(modelData.assignedRaw / 1000).toString();
                                                    asgField.selectAll(); asgField.forceActiveFocus();
                                                } }
                                            }
                                            TextField {
                                                id: asgField
                                                visible: asgCell.editing; anchors.fill: parent
                                                color: fg; font.pixelSize: 14; horizontalAlignment: Text.AlignRight
                                                inputMethodHints: Qt.ImhFormattedNumbersOnly
                                                background: Rectangle { color: "#0b0d12"; border.color: accent; border.width: 1; radius: 4 }
                                                onEditingFinished: {
                                                    if (!asgCell.editing) return;
                                                    asgCell.editing = false;
                                                    var v = parseFloat(text);
                                                    if (!isNaN(v)) {
                                                        var delta = v - Math.round(modelData.assignedRaw / 1000);
                                                        if (delta !== 0) run(callCore("assign", [modelData.name, root.month, delta.toString()]), "Assigned to " + modelData.name);
                                                    }
                                                }
                                                Keys.onEscapePressed: asgCell.editing = false
                                            }
                                        }
                                        Text { text: "" + modelData.activity; color: dim; font.pixelSize: 14; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                                        Text {
                                            text: (modelData.negative ? "⚠ " : "") + modelData.available
                                            color: availHover.hovered ? accent : (modelData.negative ? warn : good)
                                            font.pixelSize: 14; font.bold: true
                                            Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight
                                            HoverHandler { id: availHover; cursorShape: Qt.PointingHandCursor }
                                            TapHandler { onTapped: root.moveFrom(modelData.name) }
                                            ToolTip.visible: availHover.hovered; ToolTip.text: "Move money from " + modelData.name
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // "+ Add group" — a full-width, clearly-outlined affordance so it
                    // reads as "add a new group here" rather than blending into the rows.
                    Rectangle {
                        visible: !root.addingGroup
                        Layout.fillWidth: true; Layout.topMargin: 10
                        implicitHeight: 34; radius: 6
                        color: addGrpMa.containsMouse ? accent : "transparent"
                        border.color: accent; border.width: 1
                        Text { anchors.centerIn: parent; text: "＋  Add group"; font.pixelSize: 13; font.bold: true
                               color: addGrpMa.containsMouse ? bg : accent }
                        MouseArea { id: addGrpMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: { root.addingGroup = true; groupNameField.forceActiveFocus(); } }
                    }
                    RowLayout {
                        visible: root.addingGroup
                        Layout.fillWidth: true; Layout.topMargin: 10; spacing: 8
                        Field {
                            id: groupNameField; placeholderText: "new group name"; implicitWidth: 240
                            onAccepted: { if (text.trim() !== "") { run(callCore("addGroup", [text.trim()]), "Group added"); text = ""; root.addingGroup = false; } }
                        }
                        Btn { label: "Add"; onClicked: { if (groupNameField.text.trim() !== "") { run(callCore("addGroup", [groupNameField.text.trim()]), "Group added"); groupNameField.text = ""; root.addingGroup = false; } } }
                        Btn { label: "✕"; onClicked: { root.addingGroup = false; groupNameField.text = ""; } }
                    }

                    // ── Archived categories (collapsible) ──
                    Rectangle {
                        visible: root.archivedCats.length > 0
                        Layout.fillWidth: true; Layout.topMargin: 18; implicitHeight: 1; color: line
                    }
                    Text {
                        visible: root.archivedCats.length > 0
                        text: (root.showArchived ? "▾ " : "▸ ") + "Archived  (" + root.archivedCats.length + ")"
                        color: dim; font.pixelSize: 12; font.bold: true; topPadding: 8; bottomPadding: 4
                        TapHandler { onTapped: root.showArchived = !root.showArchived }
                    }
                    Repeater {
                        model: root.showArchived ? root.archivedCats : []
                        delegate: Rectangle {
                            Layout.fillWidth: true; implicitHeight: 32; radius: 6
                            color: arcHover.hovered ? panel : "transparent"
                            HoverHandler { id: arcHover }
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: 10; anchors.rightMargin: 10; spacing: 8
                                Text { text: modelData.name; color: dim; font.pixelSize: 14; Layout.fillWidth: true }
                                Text { text: "" + modelData.available; color: dim; font.pixelSize: 13 }
                                Rectangle {
                                    visible: arcHover.hovered
                                    implicitWidth: unarcT.implicitWidth + 16; implicitHeight: 22; radius: 5
                                    color: unarcMa.containsMouse ? accent : "transparent"; border.color: accent; border.width: 1
                                    Text { id: unarcT; anchors.centerIn: parent; text: "Un-archive"; font.pixelSize: 10; color: unarcMa.containsMouse ? bg : accent }
                                    MouseArea { id: unarcMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: run(callCore("unarchiveCategory", [modelData.name]), "Category restored") }
                                }
                            }
                        }
                    }

                    // ── Credit Card Payments ──
                    Rectangle {
                        visible: (budget.creditCardPayments || []).length > 0
                        Layout.fillWidth: true; Layout.topMargin: 18; implicitHeight: 1; color: line
                    }
                    Text {
                        visible: (budget.creditCardPayments || []).length > 0
                        text: "CREDIT CARD PAYMENTS"; color: accent; font.pixelSize: 12; font.bold: true; topPadding: 8; bottomPadding: 4
                    }
                    Repeater {
                        model: budget.creditCardPayments || []
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            Text { text: modelData.name; color: fg; font.pixelSize: 14; Layout.fillWidth: true; leftPadding: 10 }
                            Text { text: "" + modelData.available; color: good; font.pixelSize: 14; font.bold: true; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
                        }
                    }

                    // ── Accounts ── with inline "+ account"
                    Rectangle {
                        Layout.fillWidth: true; Layout.topMargin: 18; implicitHeight: 1; color: line
                    }
                    RowLayout {
                        Layout.fillWidth: true; Layout.topMargin: 4
                        Text { text: "ACCOUNTS"; color: accent; font.pixelSize: 12; font.bold: true; bottomPadding: 4 }
                        Item { Layout.fillWidth: true }
                        Rectangle {
                            visible: !root.addingAccount
                            implicitWidth: 80; implicitHeight: 22; radius: 5
                            color: addAcctMa.containsMouse ? accent : "transparent"; border.color: line; border.width: 1
                            Text { anchors.centerIn: parent; text: "＋ account"; font.pixelSize: 10; color: addAcctMa.containsMouse ? bg : dim }
                            MouseArea { id: addAcctMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: { root.addingAccount = true; acName.forceActiveFocus(); } }
                        }
                    }
                    // inline add-account row
                    RowLayout {
                        visible: root.addingAccount
                        Layout.fillWidth: true; Layout.leftMargin: 10; spacing: 8
                        Field { id: acName; placeholderText: "account name"; implicitWidth: 160 }
                        Drop { id: acType; model: root.accountTypes; placeholderText: "type"; implicitWidth: 130 }
                        Field { id: acBal; placeholderText: "starting balance" }
                        Btn { label: "Add"; onClicked: { if (acName.text.trim() !== "") { run(callCore("addAccount", [acName.text.trim(), acType.value || "checking", acBal.text]), "Account added"); acName.text = ""; acBal.text = ""; root.addingAccount = false; } } }
                        Btn { label: "✕"; onClicked: { root.addingAccount = false; acName.text = ""; acBal.text = ""; } }
                    }
                    Repeater {
                        model: budget.accounts || []
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            Text { text: modelData.name; color: fg; font.pixelSize: 14; Layout.fillWidth: true; leftPadding: 10 }
                            Text { text: modelData.type; color: dim; font.pixelSize: 12; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                            Text { text: "" + modelData.balance; color: fg; font.pixelSize: 14; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
                        }
                    }
                }
            }

            // ---- status footer: plain-language guidance, not accounting jargon ----
            // The old line exposed the raw invariant ("broken diff 1300"), which is
            // a developer sanity check with no user action. Instead we lead with
            // what to DO (assign / cover an over-assignment), and only mention the
            // accounting tie-out if it genuinely fails on the CURRENT month (it
            // can't meaningfully hold for a past/future month, since account
            // balances are always "now" — so we suppress it there). The technical
            // breakdown lives in the hover tooltip for the curious.
            Rectangle {
                visible: root.showGrid && !root.isEmpty
                Layout.fillWidth: true; implicitHeight: 30
                color: panel; radius: 6; border.color: line; border.width: 1

                readonly property real rta: budget.readyToAssignRaw || 0
                readonly property bool balanced: !budget.invariant || budget.invariant.ok
                readonly property string rtaAbs: String(budget.readyToAssign || "0").replace("-", "").trim()

                Text {
                    anchors.fill: parent; anchors.leftMargin: 12; anchors.rightMargin: 12
                    horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                    text: {
                        if (!root.isCurrentMonth)
                            return "Viewing " + root.viewMonth + "  ·  account balances are current — assign here to budget this month";
                        if (!parent.balanced)
                            return "⚠ Accounting doesn't balance (off by " + (budget.invariant.diff || "?") + ") — this is a data/sync glitch, not your budgeting. Try Sync, or reopen KYM.";
                        if (parent.rta > 0)
                            return "↕ " + budget.readyToAssign + " ready to assign — click a category's ASSIGNED cell (or use Assign) to give it a job";
                        if (parent.rta < 0)
                            return "⚠ Over-assigned by " + parent.rtaAbs + " — lower an assignment or add income so every category is covered";
                        return "✓ Every koruna has a job — this month is fully budgeted";
                    }
                    color: {
                        if (!root.isCurrentMonth) return dim;
                        if (!parent.balanced || parent.rta < 0) return warn;
                        if (parent.rta > 0) return accent;
                        return good;
                    }
                    font.pixelSize: 12
                }
                // Hover → the accounting identity, for anyone who wants the numbers.
                HoverHandler { id: footHover }
                ToolTip.visible: footHover.hovered
                ToolTip.text: "assets " + ((budget.invariant || {}).assets || "0")
                            + "  =  categories " + ((budget.invariant || {}).categoriesAvail || "0")
                            + "  +  Ready to Assign " + (budget.readyToAssign || "0")
            }
        }

        // ---- toast ----
        Rectangle {
            visible: root.toastText !== ""
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom; anchors.bottomMargin: 18
            radius: 8; color: root.toastError ? "#3a1e22" : "#16311f"
            border.color: root.toastError ? warn : good; border.width: 1
            implicitWidth: toastLbl.implicitWidth + 28; implicitHeight: 36
            Text { id: toastLbl; anchors.centerIn: parent; text: root.toastText
                   color: root.toastError ? warn : good; font.pixelSize: 13 }
        }

        // ---- transaction edit sheet (shared; opened from a TX row's ✎) ----
        // Edit is append-only: Save sends a txn.edit with ONLY the changed fields
        // (empty = unchanged); Delete sends a sticky txn.delete. Both ride the
        // normal sync path — on a shared budget either member can edit or delete,
        // by design (privacy is per-budget, not per-transaction).
        Popup {
            id: editTxnPop
            anchors.centerIn: Overlay.overlay
            modal: true; dim: true
            width: 340; padding: 18
            background: Rectangle { color: root.panel; border.color: root.accent; border.width: 1; radius: 12 }
            onClosed: root.editTxnData = null
            readonly property var d: root.editTxnData || ({})
            readonly property bool isIncome: editTxnPop.d.kind === "income"
            property bool confirmDel: false
            onOpened: {
                confirmDel = false;
                eAmt.text = editTxnPop.d.amountRaw !== undefined
                    ? Math.round(Math.abs(editTxnPop.d.amountRaw) / 1000).toString() : "";
                eDate.text = (editTxnPop.d.date || "").substring(0, 10);
                eCat.setValue(editTxnPop.d.category || "");
                eAcct.setValue(editTxnPop.d.account || "");
            }
            contentItem: ColumnLayout {
                spacing: 12
                RowLayout {
                    Layout.fillWidth: true
                    Text { text: "Edit transaction"; color: root.fg; font.pixelSize: 15; font.bold: true }
                    Item { Layout.fillWidth: true }
                    Text { text: editTxnPop.isIncome ? "income" : "expense"
                           color: editTxnPop.isIncome ? root.good : root.dim; font.pixelSize: 11 }
                }
                GridLayout {
                    columns: 2; columnSpacing: 10; rowSpacing: 9; Layout.fillWidth: true
                    Text { text: "Amount"; color: root.dim; font.pixelSize: 12 }
                    Field { id: eAmt; Layout.fillWidth: true; inputMethodHints: Qt.ImhFormattedNumbersOnly; placeholderText: "amount" }
                    Text { text: "Category"; color: root.dim; font.pixelSize: 12; visible: !editTxnPop.isIncome }
                    Drop { id: eCat; Layout.fillWidth: true; visible: !editTxnPop.isIncome; model: root.categoryNames; placeholderText: "category" }
                    Text { text: "Account"; color: root.dim; font.pixelSize: 12 }
                    Drop { id: eAcct; Layout.fillWidth: true; model: root.accountNames; placeholderText: "account" }
                    Text { text: "Date"; color: root.dim; font.pixelSize: 12 }
                    Field { id: eDate; Layout.fillWidth: true; placeholderText: "YYYY-MM-DD" }
                }
                Text {
                    visible: editTxnPop.confirmDel
                    text: "Delete this transaction? This removes its money from the budget."
                    color: root.warn; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                }
                RowLayout {
                    Layout.fillWidth: true; spacing: 8
                    Btn { label: editTxnPop.confirmDel ? "Really delete" : "Delete"
                          onClicked: {
                              if (!editTxnPop.confirmDel) { editTxnPop.confirmDel = true; return; }
                              var id = editTxnPop.d.id; editTxnPop.close();
                              run(callCore("deleteTxn", [id]), "Transaction deleted");
                          } }
                    Item { Layout.fillWidth: true }
                    Btn { label: "Cancel"; onClicked: editTxnPop.close() }
                    Btn { label: "Save"; primary: true
                          onClicked: {
                              var p = {};
                              if (eAmt.text.trim() !== "") p.amount = eAmt.text.trim();
                              if (!editTxnPop.isIncome && eCat.value !== "") p.category = eCat.value;
                              if (eAcct.value !== "") p.account = eAcct.value;
                              if (eDate.text.trim() !== "") p.date = eDate.text.trim();
                              var id = editTxnPop.d.id; editTxnPop.close();
                              run(callCore("editTxn", [id, JSON.stringify(p)]), "Transaction updated");
                          } }
                }
            }
        }
    }
}
