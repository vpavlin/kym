import QtQuick
import QtQuick.Layouts
import "budget.js" as Budget

// Standalone preview of the KYM budget grid — the SAME layout as module/qml/Main.qml,
// but reading the engine-produced budget.json (via gen_budget.cpp) instead of the
// live Basecamp `logos.module("kym")` replica. For rendering a screenshot outside
// the full Basecamp host. The grid code is identical to the shipped Main.qml.
Rectangle {
    id: root
    width: 760; height: 700
    color: bg

    property var budget: Budget.data

    readonly property color bg: "#14161c"
    readonly property color panel: "#1c1f28"
    readonly property color line: "#2a2f3a"
    readonly property color fg: "#e7e9ee"
    readonly property color dim: "#8b93a7"
    readonly property color good: "#4ade80"
    readonly property color warn: "#f87171"
    readonly property color accent: "#7dd3fc"

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        RowLayout {
            Layout.fillWidth: true
            spacing: 16
            ColumnLayout {
                spacing: 2
                Text { text: "KYM — Know Your Money"; color: fg; font.pixelSize: 20; font.bold: true }
                Text { text: (budget.currentMonth || "") + "  ·  KYM ready"; color: dim; font.pixelSize: 12 }
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
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Text { text: "CATEGORY"; color: dim; font.pixelSize: 11; Layout.fillWidth: true }
            Text { text: "ASSIGNED"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
            Text { text: "ACTIVITY"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
            Text { text: "AVAILABLE"; color: dim; font.pixelSize: 11; Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight }
        }

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
                                color: "transparent"; radius: 6
                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 10; anchors.rightMargin: 10
                                    Text { text: modelData.name; color: fg; font.pixelSize: 14 }
                                    Text { text: modelData.target || ""; color: modelData.targetOnTrack ? good : accent; font.pixelSize: 11; Layout.fillWidth: true; leftPadding: 10; verticalAlignment: Text.AlignVCenter }
                                    Text { text: "" + modelData.assigned; color: dim; font.pixelSize: 14; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                                    Text { text: "" + modelData.activity; color: dim; font.pixelSize: 14; Layout.preferredWidth: 110; horizontalAlignment: Text.AlignRight }
                                    Text {
                                        text: "" + modelData.available
                                        color: modelData.negative ? warn : good
                                        font.pixelSize: 14; font.bold: true
                                        Layout.preferredWidth: 120; horizontalAlignment: Text.AlignRight
                                    }
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

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 30
            color: panel; radius: 6; border.color: line; border.width: 1
            Text {
                anchors.centerIn: parent
                text: {
                    var iv = budget.invariant || {};
                    return (iv.ok ? "✓ invariant holds" : "✗ invariant broken")
                        + "   ·   assets " + (iv.assets||"0.00") + "  =  categories " + (iv.categoriesAvail||"0.00")
                        + "  +  RTA " + (budget.readyToAssign||"0.00");
                }
                color: (budget.invariant && budget.invariant.ok) ? good : warn
                font.pixelSize: 12
            }
        }
    }
}
