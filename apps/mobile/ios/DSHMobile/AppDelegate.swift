import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Under XCTest the host process must stay quiet: a second React Native
    // lifecycle here restarts the JS runtime mid-suite and tears the runner
    // down. Tests exercise the native modules directly instead.
    if NSClassFromString("XCTestCase") != nil {
      // No UI, no scene session, no React lifecycle: tests exercise the
      // native modules directly.
      return true
    }

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    // QA fixture gate: "simctl launch <udid> <bundle> -DSHSeedMarkdownDemo"
    // seeds a markdown rendering demo conversation. Absent the argument,
    // production launches are unchanged.
    var initialProperties: [AnyHashable: Any] = [:]
    if ProcessInfo.processInfo.arguments.contains("-DSHSeedMarkdownDemo") {
      initialProperties["dshSeedMarkdownDemo"] = true
    }

    factory.startReactNative(
      withModuleName: "DSHMobile",
      in: window,
      initialProperties: initialProperties,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
