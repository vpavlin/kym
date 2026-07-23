// Standalone render harness for module/qml/Main.qml. Injects a mock `logos`
// context object (module()/isViewModuleReady()/watch() + a backend exposing the
// four PROPs) so the editor QML can be rendered and screenshotted without the
// full Basecamp host. Grabs the window to a PNG after first frame, then quits.
//
// Usage: harness <Main.qml> <budget.json> <out.png>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QQuickItem>
#include <QQmlComponent>
#include <QObject>
#include <QJSValue>
#include <QTimer>
#include <QFile>
#include <QImage>
#include <QDebug>

class MockBackend : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString status READ status NOTIFY changed)
    Q_PROPERTY(bool ready READ ready NOTIFY changed)
    Q_PROPERTY(QString fingerprint READ fingerprint NOTIFY changed)
    Q_PROPERTY(QString budgetJson READ budgetJson NOTIFY changed)
public:
    explicit MockBackend(QString json, QObject *p = nullptr) : QObject(p), m_json(std::move(json)) {}
    QString status() const { return "ready · synced"; }
    bool ready() const { return true; }
    QString fingerprint() const { return "amber-oxide-cobra"; }
    QString budgetJson() const { return m_json; }
    // SLOT stubs — only reached on click; return "" (success).
    Q_INVOKABLE QString resync() { return ""; }
    Q_INVOKABLE QString loadDemo() { return ""; }
    Q_INVOKABLE QString addAccount(QString, QString, QString) { return ""; }
    Q_INVOKABLE QString addCategory(QString, QString) { return ""; }
    Q_INVOKABLE QString assign(QString, QString, QString) { return ""; }
    Q_INVOKABLE QString spend(QString, QString, QString) { return ""; }
    Q_INVOKABLE QString income(QString, QString) { return ""; }
    Q_INVOKABLE QString setTarget(QString, QString, QString, QString) { return ""; }
    Q_INVOKABLE QString reconcile(QString, QString) { return ""; }
    Q_INVOKABLE QString moveMoney(QString, QString, QString, QString) { return ""; }
    Q_INVOKABLE QString groupInit(QString) { return ""; }
    Q_INVOKABLE QString addMember(QString, QString, QString) { return ""; }
    Q_INVOKABLE QString setMemberRole(QString, QString) { return ""; }
    Q_INVOKABLE QString removeMember(QString) { return ""; }
signals:
    void changed();
private:
    QString m_json;
};

class MockLogos : public QObject {
    Q_OBJECT
public:
    explicit MockLogos(MockBackend *b, QObject *p = nullptr) : QObject(p), m_backend(b) {}
    Q_INVOKABLE QObject *module(const QString &) { return m_backend; }
    Q_INVOKABLE bool isViewModuleReady(const QString &) { return true; }
    Q_INVOKABLE void watch(QJSValue, QJSValue, QJSValue) {}
signals:
    void viewModuleReadyChanged(QString, bool);
private:
    MockBackend *m_backend;
};

int main(int argc, char **argv) {
    qInstallMessageHandler([](QtMsgType, const QMessageLogContext &, const QString &msg) {
        fprintf(stderr, "[qml] %s\n", qPrintable(msg)); fflush(stderr);
    });
    QGuiApplication app(argc, argv);
    if (argc < 4) { qWarning() << "usage: harness <Main.qml> <budget.json> <out.png>"; return 2; }
    const QString qmlPath = argv[1], jsonPath = argv[2], outPath = argv[3];

    QFile jf(jsonPath);
    if (!jf.open(QIODevice::ReadOnly)) { qWarning() << "cannot read" << jsonPath; return 2; }
    const QString json = QString::fromUtf8(jf.readAll());

    auto *backend = new MockBackend(json, &app);
    auto *logos = new MockLogos(backend, &app);

    QQmlApplicationEngine engine;
    engine.setObjectOwnership(backend, QQmlEngine::CppOwnership);
    engine.rootContext()->setContextProperty("logos", logos);

    // Wrap the Item-rooted Main.qml in a Window.
    const QString wrapper = QStringLiteral(
        "import QtQuick\nimport QtQuick.Window\n"
        "Window { width: 1120; height: 760; visible: true; color: \"#14161c\"\n"
        "  Loader { anchors.fill: parent; source: \"%1\" } }").arg(QUrl::fromLocalFile(qmlPath).toString());

    QQmlComponent comp(&engine);
    comp.setData(wrapper.toUtf8(), QUrl("harness://wrapper.qml"));
    while (comp.isLoading()) QCoreApplication::processEvents();  // import resolution can be async
    if (comp.isError()) {
        fprintf(stderr, "wrapper errors:\n");
        for (const QQmlError &e : comp.errors()) fprintf(stderr, "  %s\n", qPrintable(e.toString()));
        fflush(stderr);
        return 3;
    }
    QObject *obj = comp.create();
    if (!obj) {
        fprintf(stderr, "component create failed:\n");
        for (const QQmlError &e : comp.errors()) fprintf(stderr, "  %s\n", qPrintable(e.toString()));
        fflush(stderr);
        return 3;
    }
    auto *win = qobject_cast<QQuickWindow *>(obj);
    if (!win) { fprintf(stderr, "root is not a window (is %s)\n", obj->metaObject()->className()); fflush(stderr); return 3; }

    // Inject the fixture straight into the view's budgetJson property (the mock
    // logos has no callModule, so the view's refresh() can't populate it itself),
    // and optionally open a command-bar form (argv[4]).
    for (QObject *o : win->findChildren<QObject *>()) {
        if (QString::fromLatin1(o->metaObject()->className()).contains("Loader")) {
            if (QObject *item = o->property("item").value<QObject *>()) {
                if (argc >= 5 && QString::fromUtf8(argv[4]) == "tx") item->setProperty("_renderTx", true);
                else if (argc >= 5 && QString::fromUtf8(argv[4]) == "editsheet") item->setProperty("_renderEditSheet", true);
                else if (argc >= 5 && QString::fromUtf8(argv[4]) == "settings") item->setProperty("_renderSettings", true);
                else if (argc >= 5) item->setProperty("action", QString::fromUtf8(argv[4]));
                item->setProperty("budgetJson", backend->budgetJson());
            }
            break;
        }
    }

    int frames = 0;
    QObject::connect(win, &QQuickWindow::afterRendering, win, [&]() {
        if (++frames < 4) { win->update(); return; }  // let async layout settle
        QImage img = win->grabWindow();
        if (img.save(outPath)) qInfo() << "wrote" << outPath << img.size();
        else qWarning() << "grab/save failed";
        QTimer::singleShot(0, &app, &QGuiApplication::quit);
    }, Qt::QueuedConnection);

    QTimer::singleShot(8000, &app, &QGuiApplication::quit);  // safety
    return app.exec();
}
#include "harness.moc"
