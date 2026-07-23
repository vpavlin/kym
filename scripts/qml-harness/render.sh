#!/usr/bin/env bash
# Build + run the QML render harness headlessly (offscreen), producing a PNG of
# module/qml/Main.qml driven by a mock backend. Validates the QML actually
# renders (catches runtime errors qmllint can't) and refreshes screenshots.
set -euo pipefail

QTBASE=/nix/store/w4q31b93w262q2b75ri3jc7m3xd4i31h-qtbase-6.10.2
QTDECL=/nix/store/4z51xyah9h8h3al1wclvgy6cb04vq0vl-qtdeclarative-6.10.2
MOC=$QTBASE/libexec/moc

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HERE/kym-editor.png}"
JSON="${2:-$HERE/fixture-group.json}"
BUILD="$HERE/build"
mkdir -p "$BUILD"

# moc + compile
"$MOC" "$HERE/harness.cpp" -o "$BUILD/harness.moc"
g++ -std=c++17 -fPIC "$HERE/harness.cpp" -o "$BUILD/harness" \
  -I"$BUILD" \
  -I"$QTBASE/include" -I"$QTBASE/include/QtCore" -I"$QTBASE/include/QtGui" \
  -I"$QTDECL/include" -I"$QTDECL/include/QtQml" -I"$QTDECL/include/QtQuick" \
  -L"$QTBASE/lib" -L"$QTDECL/lib" \
  -lQt6Core -lQt6Gui -lQt6Qml -lQt6Quick

# runtime: offscreen platform + Qt import paths + software rendering
export QT_QPA_PLATFORM=offscreen
export QT_QUICK_BACKEND=software
export QT_QUICK_CONTROLS_STYLE=Basic   # required: no display style to auto-pick
export QML_IMPORT_PATH="$QTDECL/lib/qt-6/qml"
export QML2_IMPORT_PATH="$QTDECL/lib/qt-6/qml"
export QT_PLUGIN_PATH="$QTBASE/lib/qt-6/plugins:$QTDECL/lib/qt-6/plugins"
export LD_LIBRARY_PATH="$QTBASE/lib:$QTDECL/lib:${LD_LIBRARY_PATH:-}"

"$BUILD/harness" "$ROOT/module/Main.qml" "$JSON" "$OUT" "${3:-}"
echo "rendered -> $OUT"
