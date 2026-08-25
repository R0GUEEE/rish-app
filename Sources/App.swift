import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = DSHMobileViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class DSHMobileViewController: UIViewController, WKNavigationDelegate {
    private let headerView = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private let menuButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let reloadButton = UIButton(type: .system)
    private lazy var webView = makeWebView()
    private let statusView = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    private let statusLabel = UILabel()
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let retryButton = UIButton(type: .system)

    private var hostURL: URL {
        let configured = Bundle.main.object(forInfoDictionaryKey: "DSHHostURL") as? String
        return URL(string: configured ?? "http://127.0.0.1:3180/")!
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.965, green: 0.969, blue: 0.984, alpha: 1)
        configureHeader()
        configureWebView()
        configureStatusView()
        loadDSH()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    private func configureHeader() {
        headerView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(headerView)

        configureHeaderButton(menuButton, symbol: "line.3.horizontal", accessibilityLabel: "Open DSH navigation")
        menuButton.addTarget(self, action: #selector(menuRequested), for: .touchUpInside)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "DSH"
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = .label
        titleLabel.textAlignment = .center

        configureHeaderButton(reloadButton, symbol: "arrow.clockwise", accessibilityLabel: "Reload DSH")
        reloadButton.addTarget(self, action: #selector(reloadRequested), for: .touchUpInside)

        headerView.contentView.addSubview(menuButton)
        headerView.contentView.addSubview(titleLabel)
        headerView.contentView.addSubview(reloadButton)

        NSLayoutConstraint.activate([
            headerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            headerView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            headerView.heightAnchor.constraint(equalToConstant: 52),

            menuButton.leadingAnchor.constraint(equalTo: headerView.contentView.leadingAnchor, constant: 14),
            menuButton.centerYAnchor.constraint(equalTo: headerView.contentView.centerYAnchor),
            menuButton.widthAnchor.constraint(equalToConstant: 38),
            menuButton.heightAnchor.constraint(equalToConstant: 38),

            titleLabel.centerXAnchor.constraint(equalTo: headerView.contentView.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: headerView.contentView.centerYAnchor),

            reloadButton.trailingAnchor.constraint(equalTo: headerView.contentView.trailingAnchor, constant: -14),
            reloadButton.centerYAnchor.constraint(equalTo: headerView.contentView.centerYAnchor),
            reloadButton.widthAnchor.constraint(equalToConstant: 38),
            reloadButton.heightAnchor.constraint(equalToConstant: 38),
        ])
    }

    private func configureHeaderButton(
        _ button: UIButton,
        symbol: String,
        accessibilityLabel: String
    ) {
        button.translatesAutoresizingMaskIntoConstraints = false
        var configuration = UIButton.Configuration.gray()
        configuration.image = UIImage(systemName: symbol)
        configuration.baseForegroundColor = .label
        configuration.background.cornerRadius = 19
        button.configuration = configuration
        button.accessibilityLabel = accessibilityLabel
    }

    private func makeWebView() -> WKWebView {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: Self.mobileBootstrapScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.customUserAgent = "DSHMobile/0.1 iOS"
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        return webView
    }

    private func configureWebView() {
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(refreshRequested(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
    }

    private func configureStatusView() {
        statusView.translatesAutoresizingMaskIntoConstraints = false
        statusView.layer.cornerRadius = 18
        statusView.clipsToBounds = true

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = "Connecting to local DSH…"
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        activityIndicator.translatesAutoresizingMaskIntoConstraints = false
        activityIndicator.startAnimating()

        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.setTitle("Retry", for: .normal)
        retryButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retryButton.addTarget(self, action: #selector(retryRequested), for: .touchUpInside)
        retryButton.isHidden = true

        let stack = UIStackView(arrangedSubviews: [activityIndicator, statusLabel, retryButton])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        statusView.contentView.addSubview(stack)
        view.addSubview(statusView)

        NSLayoutConstraint.activate([
            statusView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusView.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 28),
            statusView.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -28),
            stack.leadingAnchor.constraint(equalTo: statusView.contentView.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: statusView.contentView.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: statusView.contentView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: statusView.contentView.bottomAnchor, constant: -20),
        ])
    }

    private func loadDSH() {
        showConnecting()
        var request = URLRequest(url: hostURL)
        request.cachePolicy = .reloadRevalidatingCacheData
        request.timeoutInterval = 15
        webView.load(request)
    }

    private func showConnecting() {
        statusView.isHidden = false
        statusLabel.text = "Connecting to local DSH…"
        statusLabel.textColor = .secondaryLabel
        retryButton.isHidden = true
        activityIndicator.isHidden = false
        activityIndicator.startAnimating()
    }

    private func showFailure(_ error: Error) {
        statusView.isHidden = false
        statusLabel.text = "Local DSH is unavailable.\n\(hostURL.absoluteString)\n\n\(error.localizedDescription)"
        statusLabel.textColor = .label
        retryButton.isHidden = false
        activityIndicator.stopAnimating()
        activityIndicator.isHidden = true
    }

    @objc private func retryRequested() {
        loadDSH()
    }

    @objc private func menuRequested() {
        webView.evaluateJavaScript(Self.toggleSidebarScript)
    }

    @objc private func reloadRequested() {
        webView.reload()
    }

    @objc private func refreshRequested(_ sender: UIRefreshControl) {
        webView.reload()
        sender.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusView.isHidden = true
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        showFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showFailure(error)
    }

    private static let mobileBootstrapScript = #"""
    (() => {
      window.__DSH_MOBILE_SHELL__ = Object.freeze({ platform: 'ios', version: 1 });

      let viewport = document.querySelector('meta[name="viewport"]');
      if (!viewport) {
        viewport = document.createElement('meta');
        viewport.name = 'viewport';
        document.head.appendChild(viewport);
      }
      viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';

      const markAppFrame = () => {
        for (const element of document.querySelectorAll('[style*="grid-template-columns"]')) {
          if (element.style.gridTemplateColumns.includes('minmax')) {
            element.classList.add('dsh-mobile-app-frame');
          }
        }
      };
      const syncKeyboardLayout = () => {
        const viewport = window.visualViewport;
        const occluded = viewport === undefined
          ? 0
          : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.classList.toggle('dsh-mobile-keyboard-open', occluded > 80);
      };
      markAppFrame();
      syncKeyboardLayout();
      new MutationObserver(markAppFrame).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'data-sidebar-collapsed']
      });
      window.addEventListener('resize', syncKeyboardLayout, { passive: true });
      window.visualViewport?.addEventListener('resize', syncKeyboardLayout, { passive: true });
      window.visualViewport?.addEventListener('scroll', syncKeyboardLayout, { passive: true });
      window.setTimeout(() => {
        const staleDetailsClose = [...document.querySelectorAll('button')].find((candidate) =>
          /close details|关闭详情/i.test(candidate.getAttribute('aria-label') ?? '')
        );
        staleDetailsClose?.click();
      }, 150);

      if (!document.getElementById('dsh-mobile-shell-style')) {
        const style = document.createElement('style');
        style.id = 'dsh-mobile-shell-style';
        style.textContent = `
          html, body, #root {
            width: 100%;
            max-width: 100%;
            min-height: 100%;
            overscroll-behavior: none;
            -webkit-text-size-adjust: 100%;
          }
          input, textarea, select {
            font-size: 16px !important;
          }
          button, [role="button"], a {
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          @media (max-width: 600px) {
            [data-radix-popper-content-wrapper] {
              max-width: calc(100vw - 16px) !important;
            }
            .dsh-mobile-app-frame {
              grid-template-columns: 0 minmax(0, 1fr) 0 !important;
            }
            /* Keep the first grid item mounted. display:none would cause CSS
               Grid auto-placement to move the conversation into the 0px rail. */
            .dsh-mobile-app-frame[data-sidebar-collapsed] > :first-child {
              visibility: hidden !important;
              pointer-events: none !important;
              border-right: none !important;
            }
            .dsh-mobile-app-frame > :nth-child(3) {
              display: none !important;
            }
            [data-composer-card] {
              transition: translate 180ms ease-out;
            }
            .dsh-mobile-keyboard-open [data-composer-card] {
              translate: 0 -58px;
            }
            .dsh-mobile-app-frame:not([data-sidebar-collapsed])::after {
              position: absolute;
              z-index: 80;
              inset: 0;
              background: color-mix(in srgb, #111827 18%, transparent);
              content: '';
              pointer-events: none;
            }
            .dsh-mobile-app-frame:not([data-sidebar-collapsed]) > :first-child {
              position: absolute !important;
              z-index: 90;
              inset: 0 auto 0 0;
              width: min(84vw, 320px) !important;
              max-width: min(84vw, 320px) !important;
              box-shadow: 12px 0 36px rgb(15 23 42 / 18%);
            }
            .dsh-mobile-app-frame:not([data-sidebar-collapsed]) > :first-child > * {
              width: 100% !important;
            }
            h1 {
              font-size: clamp(26px, 8vw, 34px) !important;
              line-height: 1.15 !important;
            }
            [role="dialog"] {
              width: 100vw !important;
              height: 100% !important;
              max-width: none !important;
              border-radius: 0 !important;
              flex-direction: column !important;
            }
            [role="dialog"] > nav {
              width: 100% !important;
              gap: 10px !important;
              padding: 14px 16px 0 !important;
            }
            [role="dialog"] > nav > :last-child {
              flex-direction: row !important;
              gap: 6px !important;
              overflow-x: auto !important;
              scrollbar-width: none;
            }
            [role="dialog"] > nav > :last-child::-webkit-scrollbar {
              display: none;
            }
            [role="dialog"] > nav > :last-child > button {
              flex: 0 0 auto !important;
              width: auto !important;
            }
          }
        `;
        document.head.appendChild(style);
      }
    })();
    """#

    private static let toggleSidebarScript = #"""
    (() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        /sidebar|侧边栏/i.test(candidate.getAttribute('aria-label') ?? '')
      );
      button?.click();
      return button !== undefined;
    })();
    """#

}
