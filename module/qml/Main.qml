import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

// KYM budget — the Basecamp editor. Renders off the backend's folded budgetJson
// PROP and drives edits through the backend SLOTs (logos.watch). A command bar
// opens inline forms; clicking a category opens Assign pre-filled.
Item {
    id: root

    readonly property var backend: logos.module("kym")
    property bool ready: false
    readonly property var budget: {
        if (!backend) return ({});
        try { return JSON.parse(backend.budgetJson || "{}"); } catch (e) { return ({}); }
    }
    readonly property string status: backend ? backend.status : "…"
    readonly property string month: budget.currentMonth || ""

    // palette
    readonly property color bg: "#14161c"
    readonly property color panel: "#1c1f28"
    readonly property color line: "#2a2f3a"
    readonly property color fg: "#e7e9ee"
    readonly property color dim: "#8b93a7"
    readonly property color good: "#4ade80"
    readonly property color warn: "#f87171"
    readonly property color accent: "#7dd3fc"

    property string action: ""   // "" | expense | income | assign | move | target | account | category | reconcile

    // ---- toast (visibility of system status) ----
    property string toastText: ""
    property bool toastError: false
    Timer { id: toastTimer; interval: 3400; onTriggered: root.toastText = "" }
    function showToast(t, err) { root.toastText = t; root.toastError = err; toastTimer.restart(); }

    // Run a backend SLOT. Our SLOTs RESOLVE with "" on success or an error
    // message on failure (not a rejection), so inspect the result: show the
    // error, or close the form + confirm on success.
    function run(promise, okMsg) {
        if (!promise) return;
        logos.watch(promise,
            function (result) {
                if (result && String(result).length > 0) { showToast(String(result), true); }
                else { root.action = ""; showToast(okMsg || "Saved", false); }
            },
            function (e) { showToast("Couldn't reach the budget: " + e, true); });
    }
    function openAction(a) { root.action = (root.action === a ? "" : a); }

    Connections {
        target: logos
        function onViewModuleReadyChanged(moduleName, isReady) {
            if (moduleName === "kym") root.ready = isReady && root.backend !== null;
        }
    }
    Component.onCompleted: root.ready = backend !== null && logos.isViewModuleReady("kym")

    // ---- reusable themed controls ----
    component Btn: Rectangle {
        property string label
        property bool active: false
        signal clicked()
        implicitHeight: 30; implicitWidth: bt.implicitWidth + 22; radius: 6
        color: ma.containsMouse || active ? root.accent : root.panel
        border.color: root.line; border.width: 1
        Text { id: bt; anchors.centerIn: parent; text: parent.label
               color: (ma.containsMouse || parent.active) ? root.bg : root.fg; font.pixelSize: 13 }
        MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; onClicked: parent.clicked() }
    }
    component Field: TextField {
        color: root.fg; font.pixelSize: 13; selectByMouse: true
        placeholderTextColor: root.dim
        implicitWidth: 96; implicitHeight: 30
        background: Rectangle { color: "#0b0d12"; border.color: root.line; border.width: 1; radius: 5 }
    }

    Rectangle {
        anchors.fill: parent
        color: bg

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10

            // ---- header ----
            RowLayout {
                Layout.fillWidth: true
                spacing: 16
                ColumnLayout {
                    spacing: 2
                    Text { text: "KYM — Know Your Money"; color: fg; font.pixelSize: 20; font.bold: true }
                    Text { text: (root.month || "") + "  ·  " + status; color: dim; font.pixelSize: 12 }
                }
                Item { Layout.fillWidth: true }
                Rectangle {
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
                        // Non-color status word (WCAG 1.4.1 — don't rely on color alone).
                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: budget.readyToAssignRaw < 0 ? "⚠ over-assigned"
                                : (budget.readyToAssignRaw === 0 ? "✓ all assigned" : "to assign")
                            color: (budget.readyToAssignRaw < 0) ? warn : (budget.readyToAssignRaw === 0 ? good : dim)
                            font.pixelSize: 10
                        }
                    }
                }
            }

            // ---- command bar ----
            Flow {
                Layout.fillWidth: true
                spacing: 6
                Btn { label: "+ Expense"; active: action === "expense"; onClicked: openAction("expense") }
                Btn { label: "+ Income"; active: action === "income"; onClicked: openAction("income") }
                Btn { label: "Assign"; active: action === "assign"; onClicked: openAction("assign") }
                Btn { label: "Move"; active: action === "move"; onClicked: openAction("move") }
                Btn { label: "Target"; active: action === "target"; onClicked: openAction("target") }
                Btn { label: "Reconcile"; active: action === "reconcile"; onClicked: openAction("reconcile") }
                Btn { label: "+ Account"; active: action === "account"; onClicked: openAction("account") }
                Btn { label: "+ Category"; active: action === "category"; onClicked: openAction("category") }
                Btn { label: "Sync"; onClicked: run(backend.resync(), "Re-broadcasting to peers…") }
            }

            // ---- action panel (inline forms; type names, the backend resolves them) ----
            Rectangle {
                Layout.fillWidth: true
                visible: action !== ""
                implicitHeight: 44
                color: panel; radius: 8; border.color: line; border.width: 1
                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 12; anchors.rightMargin: 12
                    spacing: 8

                    // Expense
                    RowLayout { visible: action === "expense"; spacing: 8
                        Field { id: exAmt; placeholderText: "amount" }
                        Field { id: exAcct; placeholderText: "account" }
                        Field { id: exCat; placeholderText: "category"; implicitWidth: 130 }
                        Btn { label: "Add expense"; onClicked: run(backend.spend(exAmt.text, exAcct.text, exCat.text)) }
                    }
                    // Income
                    RowLayout { visible: action === "income"; spacing: 8
                        Field { id: inAmt; placeholderText: "amount" }
                        Field { id: inAcct; placeholderText: "account" }
                        Btn { label: "Add income"; onClicked: run(backend.income(inAmt.text, inAcct.text)) }
                    }
                    // Assign
                    RowLayout { visible: action === "assign"; spacing: 8
                        Field { id: asgCat; placeholderText: "category"; implicitWidth: 130 }
                        Field { id: asgAmt; placeholderText: "+ amount" }
                        Btn { label: "Assign"; onClicked: run(backend.assign(asgCat.text, root.month, asgAmt.text)) }
                    }
                    // Move
                    RowLayout { visible: action === "move"; spacing: 8
                        Field { id: mvFrom; placeholderText: "from category"; implicitWidth: 130 }
                        Field { id: mvTo; placeholderText: "to category"; implicitWidth: 130 }
                        Field { id: mvAmt; placeholderText: "amount" }
                        Btn { label: "Move"; onClicked: run(backend.moveMoney(mvFrom.text, mvTo.text, root.month, mvAmt.text)) }
                    }
                    // Target
                    RowLayout { visible: action === "target"; spacing: 8
                        Field { id: tgCat; placeholderText: "category"; implicitWidth: 130 }
                        Field { id: tgType; placeholderText: "monthly|balance"; implicitWidth: 130; text: "monthly" }
                        Field { id: tgAmt; placeholderText: "amount" }
                        Btn { label: "Set target"; onClicked: run(backend.setTarget(tgCat.text, tgType.text, tgAmt.text, "")) }
                    }
                    // Reconcile
                    RowLayout { visible: action === "reconcile"; spacing: 8
                        Field { id: rcAcct; placeholderText: "account" }
                        Field { id: rcActual; placeholderText: "bank balance" }
                        Btn { label: "Reconcile"; onClicked: run(backend.reconcile(rcAcct.text, rcActual.text)) }
                    }
                    // Add account
                    RowLayout { visible: action === "account"; spacing: 8
                        Field { id: acName; placeholderText: "name" }
                        Field { id: acType; placeholderText: "checking|savings|creditCard|tracking"; implicitWidth: 220; text: "checking" }
                        Field { id: acBal; placeholderText: "starting balance" }
                        Btn { label: "Add account"; onClicked: run(backend.addAccount(acName.text, acType.text, acBal.text)) }
                    }
                    // Add category
                    RowLayout { visible: action === "category"; spacing: 8
                        Field { id: ctName; placeholderText: "name"; implicitWidth: 130 }
                        Field { id: ctGroup; placeholderText: "group"; implicitWidth: 130 }
                        Btn { label: "Add category"; onClicked: run(backend.addCategory(ctName.text, ctGroup.text)) }
                    }
                    Item { Layout.fillWidth: true }
                    Btn { label: "✕"; onClicked: action = "" }
                }
            }

            // ---- column headers ----
            RowLayout {
                Layout.fillWidth: true
                Text { text: "CATEGORY"; color: dim; font.pixelSize: 11; Layout.fillWidth: true }
                Text { text: "ASSIGNED"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                Text { text: "ACTIVITY"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                Text { text: "AVAILABLE"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
            }

            // ---- the grid ----
            Flickable {
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentHeight: gridCol.implicitHeight
                clip: true
                ColumnLayout {
                    id: gridCol
                    width: parent.width
                    spacing: 6

                    Repeater {
                        model: budget.groups || []
                        delegate: ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 0
                            Text { text: modelData.name; color: accent; font.pixelSize: 13; font.bold: true; topPadding: 8; bottomPadding: 4 }
                            Repeater {
                                model: modelData.categories || []
                                delegate: Rectangle {
                                    Layout.fillWidth: true
                                    implicitHeight: 34
                                    color: rowMouse.containsMouse ? panel : "transparent"
                                    radius: 6
                                    RowLayout {
                                        anchors.fill: parent
                                        anchors.leftMargin: 10; anchors.rightMargin: 10
                                        Text { text: modelData.name; color: fg; font.pixelSize: 14 }
                                        Text { text: modelData.target || ""; color: modelData.targetOnTrack ? good : accent; font.pixelSize: 11; Layout.fillWidth: true; leftPadding: 10; verticalAlignment: Text.AlignVCenter }
                                        Text { text: "" + modelData.assigned; color: rowMouse.containsMouse ? accent : dim; font.pixelSize: 14; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                                        Text { text: "" + modelData.activity; color: dim; font.pixelSize: 14; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                                        Text {
                                            // ⚠ marks overspent so it's not signalled by red alone (WCAG 1.4.1).
                                            text: (modelData.negative ? "⚠ " : "") + modelData.available
                                            color: modelData.negative ? warn : good
                                            font.pixelSize: 14; font.bold: true
                                            Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight
                                        }
                                    }
                                    // Click a category -> open Assign pre-filled (give every dollar a job).
                                    MouseArea {
                                        id: rowMouse; anchors.fill: parent; hoverEnabled: true
                                        onClicked: { root.action = "assign"; asgCat.text = modelData.name; asgAmt.forceActiveFocus(); }
                                    }
                                }
                            }
                        }
                    }

                    Text {
                        visible: (budget.creditCardPayments || []).length > 0
                        text: "Credit Card Payments"; color: accent; font.pixelSize: 13; font.bold: true; topPadding: 12; bottomPadding: 4
                    }
                    Repeater {
                        model: budget.creditCardPayments || []
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            Text { text: modelData.name; color: fg; font.pixelSize: 14; Layout.fillWidth: true; leftPadding: 10 }
                            Text { text: "" + modelData.available; color: good; font.pixelSize: 14; font.bold: true; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
                        }
                    }

                    Text { text: "Accounts"; color: accent; font.pixelSize: 13; font.bold: true; topPadding: 12; bottomPadding: 4 }
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

            // ---- invariant footer ----
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 30
                color: panel; radius: 6; border.color: line; border.width: 1
                Text {
                    anchors.centerIn: parent
                    text: {
                        var iv = budget.invariant || {};
                        return (iv.ok ? "✓ invariant holds" : "✗ invariant broken (diff " + (iv.diff || "?") + ")")
                            + "   ·   assets " + (iv.assets || "0.00") + "  =  categories " + (iv.categoriesAvail || "0.00")
                            + "  +  RTA " + (budget.readyToAssign || "0.00");
                    }
                    color: (budget.invariant && budget.invariant.ok) ? good : warn
                    font.pixelSize: 12
                }
            }
        }

        // ---- toast: success / error feedback (Nielsen: visibility of system status) ----
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
    }
}
