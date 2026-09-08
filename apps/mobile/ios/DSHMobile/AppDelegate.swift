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

    TaskExperience.shared.configure()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    // QA fixture gates, launch arguments only (production launches carry
    // none): "simctl launch <udid> <bundle> -DSHSeedMarkdownDemo" seeds a
    // markdown rendering demo conversation; "-DSHUIPreview <kind>" renders
    // the approval-single / approval-batch / policy-panel screenshot preview
    // with fixed display data instead of the home screen.
    var initialProperties: [AnyHashable: Any] = [:]
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-DSHSeedMarkdownDemo") {
      initialProperties["dshSeedMarkdownDemo"] = true
    }
    if let index = arguments.firstIndex(of: "-DSHUIPreview"),
       arguments.indices.contains(index + 1) {
      initialProperties["dshUIPreview"] = arguments[index + 1]
    }

    factory.startReactNative(
      withModuleName: "DSHMobile",
      in: window,
      initialProperties: initialProperties,
      launchOptions: launchOptions
    )

    TaskExperienceAcceptance.startIfRequested()
    return true
  }
  func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    TaskExperience.shared.open(url)
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
